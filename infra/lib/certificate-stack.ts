import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';

export interface CertificateStackProps extends cdk.StackProps {
  domainName: string;
}

/**
 * CloudFront requires its ACM certificate to live in us-east-1 regardless of which region the
 * rest of the stack deploys to (BbTournamentStack defaults to eu-west-1) — hence this separate
 * stack, pinned to us-east-1, referenced cross-region by BbTournamentStack (see bin/app.ts,
 * `crossRegionReferences: true`).
 *
 * The domain was bought through Route53 Domains, which auto-creates a public hosted zone for it
 * — `HostedZone.fromLookup` finds that existing zone (queries the deploying AWS account at synth
 * time; requires real AWS credentials, so `cdk synth`/`deploy` must run somewhere with them, not
 * in this dev sandbox). Passing that zone to `CertificateValidation.fromDns(hostedZone)` lets CDK
 * create the DNS validation record itself — no manual CNAME step, unlike a domain hosted outside
 * Route53.
 */
export class CertificateStack extends cdk.Stack {
  public readonly certificate: acm.ICertificate;

  constructor(scope: Construct, id: string, props: CertificateStackProps) {
    super(scope, id, props);

    const hostedZone = route53.HostedZone.fromLookup(this, 'HostedZone', { domainName: props.domainName });

    this.certificate = new acm.Certificate(this, 'Certificate', {
      domainName: props.domainName,
      validation: acm.CertificateValidation.fromDns(hostedZone),
    });

    new cdk.CfnOutput(this, 'CertificateArn', { value: this.certificate.certificateArn });
  }
}
