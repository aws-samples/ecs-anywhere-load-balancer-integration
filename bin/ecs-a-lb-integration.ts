#!/usr/bin/env node
import * as dotenv from "dotenv";
dotenv.config();
dotenv.config({ path: `.env.local`, override: true });

import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import { EcsALbIntegrationStack } from "../lib/ecs-a-lb-integration-stack";

const app = new cdk.App();
new EcsALbIntegrationStack(app, "EcsALbIntegrationStack", {
  env: {
    account: process.env.AWS_ACCOUNT_ID,
    region: process.env.AWS_REGION || "ap-southeast-1",
  },
});
