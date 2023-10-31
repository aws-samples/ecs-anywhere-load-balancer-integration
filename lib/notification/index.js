import { IncomingWebhook } from "@slack/webhook";

const url = process.env.SLACK_WEBHOOK_URL;

const webhook = new IncomingWebhook(url);

export const handler = async function (event, context) {
  const body = JSON.parse(event.Records[0].body);
  console.log(body.responsePayload);
  await webhook.send({ text: body.responsePayload });
};
