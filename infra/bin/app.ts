#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { BbTournamentStack } from '../lib/bb-tournament-stack';
import { CertificateStack } from '../lib/certificate-stack';

const app = new cdk.App();

const account = process.env.CDK_DEFAULT_ACCOUNT;
const domainName = 'bb-tournament.eu';

// CloudFront's certificate must live in us-east-1 no matter which region the rest of the stack
// deploys to — a separate stack pinned there, referenced cross-region below.
const certStack = new CertificateStack(app, 'BbTournamentCertStack', {
  env: { account, region: 'us-east-1' },
  crossRegionReferences: true,
  domainName,
});

new BbTournamentStack(app, 'BbTournamentStack', {
  env: {
    account,
    region: process.env.CDK_DEFAULT_REGION ?? 'eu-west-1',
  },
  crossRegionReferences: true,
  domainName,
  certificate: certStack.certificate,
});
