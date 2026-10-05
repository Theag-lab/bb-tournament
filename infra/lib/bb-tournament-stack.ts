import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigwv2integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53targets from 'aws-cdk-lib/aws-route53-targets';

export interface BbTournamentStackProps extends cdk.StackProps {
  /**
   * Custom domain for the CloudFront distribution + the ACM certificate (already issued in
   * us-east-1) to serve it with. Both optional: omitting them keeps the stack on the free default
   * `*.cloudfront.net` domain, exactly as before this domain was purchased.
   */
  domainName?: string;
  certificate?: acm.ICertificate;
}

export class BbTournamentStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: BbTournamentStackProps) {
    super(scope, id, props);

    // --- Tournament data storage: one JSON object per tournament, no database ---
    // Versioning used to be on here, but it kept a noncurrent version on every single write
    // (every result submission, every admin tweak) and piled up far too many objects. Replaced by
    // an explicit backup copy (storage.backupTournament) taken once per round launch instead — the
    // lifecycle rule below is kept only to age out whatever noncurrent versions already
    // accumulated from before this change.
    const dataBucket = new s3.Bucket(this, 'DataBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      lifecycleRules: [
        {
          noncurrentVersionExpiration: cdk.Duration.days(30),
        },
      ],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // --- Public roster image uploads: one object per team, key has no extension,
    // the browser-set Content-Type at upload time is what's served back. ---
    const assetsBucket = new s3.Bucket(this, 'AssetsBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      cors: [
        {
          allowedMethods: [s3.HttpMethods.POST, s3.HttpMethods.PUT],
          allowedOrigins: ['*'],
          allowedHeaders: ['*'],
          exposedHeaders: ['ETag'],
          maxAge: 3000,
        },
      ],
    });

    // --- API Lambda ---
    const apiFunction = new lambda.Function(this, 'ApiFunction', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', '..', 'backend', 'dist')),
      memorySize: 256,
      // Was 10s; bumped for the match-sheet log download (handlers/logs.ts), which can page
      // through a full week of this shared Lambda's own log volume (every invocation, including
      // every 60s poll from every open page) — comfortably fast for every other route, but
      // FilterLogEvents over that much volume can take a while. logs.ts also self-limits to a
      // time budget well under this so it returns a (possibly partial) result instead of being
      // killed mid-request.
      timeout: cdk.Duration.seconds(30),
      environment: {
        DATA_BUCKET_NAME: dataBucket.bucketName,
        ASSETS_BUCKET_NAME: assetsBucket.bucketName,
      },
      architecture: lambda.Architecture.ARM_64,
    });
    dataBucket.grantReadWrite(apiFunction, 'tournaments/*');
    // The Lambda only *signs* presigned POSTs for roster images; it never reads/serves them
    // itself (CloudFront + the browser handle that), so it needs put/delete but not get.
    assetsBucket.grantPut(apiFunction, 'roster-images/*');
    assetsBucket.grantDelete(apiFunction, 'roster-images/*');
    // Lambdas can write their own logs by default, but not read them back — needed for the
    // admin's "download this tournament's match-sheet logs" export (handlers/logs.ts), which
    // filters this same function's own log group. The resource pattern deliberately wildcards the
    // function-name segment instead of referencing `apiFunction.functionName`/`apiFunction.logGroup`:
    // either one would put a reference to the function inside its OWN role's policy, and since the
    // function already has an explicit CloudFormation DependsOn on that policy (standard CDK
    // behaviour, for IAM propagation), that reference closes a circular dependency
    // (Function -> its role's policy -> Function). There's only one Lambda in this stack, so the
    // wildcard is no broader in practice than naming it directly.
    apiFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['logs:FilterLogEvents'],
        resources: [`arn:aws:logs:${this.region}:${this.account}:log-group:/aws/lambda/*:*`],
      })
    );

    const httpApi = new apigwv2.HttpApi(this, 'HttpApi', {
      defaultIntegration: new apigwv2integrations.HttpLambdaIntegration('DefaultIntegration', apiFunction),
    });
    // Light throttle: cheap defense-in-depth against brute-forcing the 4-character team codes.
    // Set directly on the auto-created $default stage (rather than an explicit HttpStage) so the
    // logical id/physical stage name don't change on accounts that already deployed the v1 stack.
    const cfnDefaultStage = httpApi.defaultStage!.node.defaultChild as apigwv2.CfnStage;
    cfnDefaultStage.defaultRouteSettings = {
      throttlingRateLimit: 50,
      throttlingBurstLimit: 100,
    };

    // --- Static frontend hosting ---
    const siteBucket = new s3.Bucket(this, 'SiteBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const apiOriginDomain = cdk.Fn.select(2, cdk.Fn.split('/', httpApi.apiEndpoint));

    // `v` (the upload timestamp) busts the cache on each new roster image upload.
    const rosterImageCachePolicy = new cloudfront.CachePolicy(this, 'RosterImageCachePolicy', {
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.allowList('v'),
      headerBehavior: cloudfront.CacheHeaderBehavior.none(),
      cookieBehavior: cloudfront.CacheCookieBehavior.none(),
      defaultTtl: cdk.Duration.days(1),
      maxTtl: cdk.Duration.days(7),
      minTtl: cdk.Duration.seconds(0),
    });

    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      defaultRootObject: 'index.html',
      domainNames: props?.domainName ? [props.domainName] : undefined,
      certificate: props?.certificate,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(siteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      additionalBehaviors: {
        '/api/*': {
          origin: new origins.HttpOrigin(apiOriginDomain, {
            protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
          }),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        },
        '/roster-images/*': {
          origin: origins.S3BucketOrigin.withOriginAccessControl(assetsBucket),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: rosterImageCachePolicy,
        },
      },
      errorResponses: [
        // Angular client-side routing: unknown paths fall back to index.html.
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: '/index.html', ttl: cdk.Duration.seconds(0) },
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: '/index.html', ttl: cdk.Duration.seconds(0) },
      ],
    });

    const frontendBuildDir = path.join(__dirname, '..', '..', 'frontend', 'dist', 'frontend', 'browser');

    // Every build's JS/CSS filenames are content-hashed (new content -> new filename), so they're
    // safe to cache for a long time — they're never mutated at a given URL, only replaced by a
    // differently-named file next build.
    const assetsDeployment = new s3deploy.BucketDeployment(this, 'DeploySite', {
      sources: [s3deploy.Source.asset(frontendBuildDir, { exclude: ['index.html'] })],
      destinationBucket: siteBucket,
      cacheControl: [s3deploy.CacheControl.maxAge(cdk.Duration.days(365)), s3deploy.CacheControl.immutable()],
      // Needs prune: false — see the "index.html gets its own deployment" comment below.
      prune: false,
    });

    // index.html references THIS build's hashed chunk filenames, and old chunks get pruned from
    // the bucket next deploy — so a browser (or an intermediate cache) serving a STALE cached
    // index.html after a deploy would 404 on chunks that no longer exist, which is exactly the
    // black-screen-after-deploy symptom this fixes. index.html must always be revalidated, never
    // served from a stale cache. It needs its own BucketDeployment (one cacheControl applies per
    // deployment) with prune: false on both deployments, since each only tracks the files it
    // itself uploaded — prune: true here would delete the other deployment's files from their
    // shared destination. See the CDK docs' s3-deployment README, "Prune" section.
    const indexDeployment = new s3deploy.BucketDeployment(this, 'DeployIndexHtml', {
      sources: [s3deploy.Source.asset(frontendBuildDir, { exclude: ['*', '!index.html'] })],
      destinationBucket: siteBucket,
      cacheControl: [s3deploy.CacheControl.noCache(), s3deploy.CacheControl.mustRevalidate()],
      prune: false,
      distribution,
      distributionPaths: ['/*'],
    });
    // Belt-and-suspenders: makes sure this build's new chunks are already in the bucket before
    // index.html (which references them) gets published and the CloudFront invalidation fires.
    indexDeployment.node.addDependency(assetsDeployment);

    // The domain was bought via Route53 Domains, which auto-creates a hosted zone for it — point
    // the apex at CloudFront with a native Alias record (handles the apex, unlike a plain CNAME,
    // which DNS doesn't allow at a zone's root) instead of asking for a manual DNS record.
    if (props?.domainName) {
      const hostedZone = route53.HostedZone.fromLookup(this, 'HostedZone', { domainName: props.domainName });
      const target = route53.RecordTarget.fromAlias(new route53targets.CloudFrontTarget(distribution));
      new route53.ARecord(this, 'SiteAliasRecordA', { zone: hostedZone, target });
      new route53.AaaaRecord(this, 'SiteAliasRecordAAAA', { zone: hostedZone, target });
    }

    new cdk.CfnOutput(this, 'SiteUrl', {
      value: `https://${props?.domainName ?? distribution.domainName}`,
    });
    new cdk.CfnOutput(this, 'DistributionDomainName', { value: distribution.domainName });
    new cdk.CfnOutput(this, 'ApiEndpoint', { value: httpApi.apiEndpoint });
    new cdk.CfnOutput(this, 'DataBucketName', { value: dataBucket.bucketName });
    new cdk.CfnOutput(this, 'AssetsBucketName', { value: assetsBucket.bucketName });
  }
}
