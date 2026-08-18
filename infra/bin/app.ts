#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { BbTournamentStack } from '../lib/bb-tournament-stack';

const app = new cdk.App();
new BbTournamentStack(app, 'BbTournamentStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'eu-west-1',
  },
});
