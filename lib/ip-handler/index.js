import {
  ECSClient,
  DescribeTasksCommand,
  DescribeContainerInstancesCommand,
} from "@aws-sdk/client-ecs";

import {
  SSMClient,
  DescribeInstanceInformationCommand,
} from "@aws-sdk/client-ssm";

import {
  ElasticLoadBalancingV2Client,
  RegisterTargetsCommand,
  DeregisterTargetsCommand,
} from "@aws-sdk/client-elastic-load-balancing-v2";

import { metricScope, Unit, StorageResolution } from "aws-embedded-metrics";

const ecsClient = new ECSClient();
const ssmClient = new SSMClient();
const elbv2Client = new ElasticLoadBalancingV2Client();

const targetGroupArn = process.env.TARGET_GROUP_ARN;

export const handler = metricScope((metrics) => async (event, context) => {
  console.log(JSON.stringify(event, null, 2));
  try {
    const { taskArn, containerInstanceArn, lastStatus, group } = event.detail;
    if (lastStatus !== "RUNNING" && lastStatus !== "STOPPED") {
      return;
    }
    const cluster = taskArn.split("/")[1];
    const service = group.split(":")[1];
    const task = taskArn.split("/")[2];
    metrics.setNamespace("ECS-A");
    metrics.setDimensions([{ Cluster: cluster, Service: service }], false);
    metrics.setProperty("RequestId", context.awsRequestId);
    metrics.setProperty("EventId", event.id);
    metrics.setProperty("TaskId", task);
    let data = await ecsClient.send(
      new DescribeTasksCommand({ cluster, tasks: [taskArn] })
    );
    const { hostPort } = data.tasks[0].containers[0].networkBindings[0];
    console.log(`hostPort: ${hostPort}`);
    data = await ecsClient.send(
      new DescribeContainerInstancesCommand({
        cluster,
        containerInstances: [containerInstanceArn],
      })
    );
    const { ec2InstanceId } = data.containerInstances[0];
    console.log(`ec2InstanceId: ${ec2InstanceId}`);
    data = await ssmClient.send(
      new DescribeInstanceInformationCommand({
        Filters: [{ Key: "InstanceIds", Values: [ec2InstanceId] }],
      })
    );
    const ipAddress = data.InstanceInformationList[0].IPAddress;
    console.log(`ipAddress: ${ipAddress}`);
    if (lastStatus == "RUNNING") {
      console.log(`Registering ${ipAddress}:${hostPort}...`);
      try {
        data = await elbv2Client.send(
          new RegisterTargetsCommand({
            TargetGroupArn: targetGroupArn,
            Targets: [
              { Id: ipAddress, Port: hostPort, AvailabilityZone: "all" },
            ],
          })
        );
        const name = "SuccessRegistering";
        metrics.putMetric(name, 1, Unit.Count, StorageResolution.Standard);
        return `Success: Registering ${ipAddress}:${hostPort}.`;
      } catch (error) {
        console.log(error);
        const name = "FailRegistering";
        metrics.putMetric(name, 1, Unit.Count, StorageResolution.Standard);
        return `Fail: Registering ${ipAddress}:${hostPort}.`;
      }
    } else {
      console.log(`Deregistering ${ipAddress}:${hostPort}...`);
      try {
        data = await elbv2Client.send(
          new DeregisterTargetsCommand({
            TargetGroupArn: targetGroupArn,
            Targets: [
              { Id: ipAddress, Port: hostPort, AvailabilityZone: "all" },
            ],
          })
        );
        const name = "SuccessDeregistering";
        metrics.putMetric(name, 1, Unit.Count, StorageResolution.Standard);
        return `Success: Deregistering ${ipAddress}:${hostPort}.`;
      } catch (error) {
        console.log(error);
        const name = "FailDeregistering";
        metrics.putMetric(name, 1, Unit.Count, StorageResolution.Standard);
        return `Fail: Deregistering ${ipAddress}:${hostPort}.`;
      }
    }
  } catch (error) {
    console.log(error);
    metrics.putMetric("Error", 1, Unit.Count, StorageResolution.Standard);
    throw error;
  }
});
