import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { HistoryCoordinator } from './data/player-history-coordinator.js';
import { createHistoryDispatcher, createHistoryWorker, historyQueueReferenceSchema, processHistorySteps,
  type HistoryQueueReference } from './history-transport.js';

const dynamodb = new DynamoDBClient({}), sqs = new SQSClient({});
const enabled = () => process.env.HISTORY_PROCESSING_ENABLED === 'true';
function required(name: string): string {
  const value = process.env[name];
  if (!value || !value.trim()) throw new Error('history_configuration_unavailable');
  return value;
}
async function send(reference: HistoryQueueReference, delaySeconds = 0): Promise<void> {
  await sqs.send(new SendMessageCommand({ QueueUrl: required('HISTORY_QUEUE_URL'),
    MessageBody: JSON.stringify(historyQueueReferenceSchema.parse(reference)), DelaySeconds: delaySeconds }));
}
export const dispatchHandler = createHistoryDispatcher({ enabled, send });
export const workHandler = (event: unknown, context?: { getRemainingTimeInMillis(): number }) =>
  createHistoryWorker({ enabled, send, process: async reference => {
    // Both configuration values are required before advancing a checkpoint.
    required('HISTORY_QUEUE_URL');
    const coordinator = new HistoryCoordinator(dynamodb, required('DYNAMODB_TABLE'));
    return processHistorySteps(reference, ref => coordinator.process(ref), {
      ...(context ? { remaining: () => context.getRemainingTimeInMillis() } : {})
    });
  } })(event);
