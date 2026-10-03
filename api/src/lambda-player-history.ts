import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { HistoryCoordinator } from './data/player-history-coordinator.js';
import { PlayerPortraitWorker } from './data/player-portrait-worker.js';
import { createPortraitStore } from './media/portrait-store.js';
import { ProfileNameWorker } from './data/player-profile-name-worker.js';
import { createHistoryDispatcher, createHistoryWorker, workQueueReferenceSchema, processHistorySteps,
  type WorkQueueReference } from './history-transport.js';

const dynamodb = new DynamoDBClient({}), sqs = new SQSClient({});
const enabled = () => process.env.HISTORY_PROCESSING_ENABLED === 'true';
function required(name: string): string {
  const value = process.env[name];
  if (!value || !value.trim()) throw new Error('history_configuration_unavailable');
  return value;
}
async function send(reference: WorkQueueReference, delaySeconds = 0): Promise<void> {
  await sqs.send(new SendMessageCommand({ QueueUrl: required('HISTORY_QUEUE_URL'),
    MessageBody: JSON.stringify(workQueueReferenceSchema.parse(reference)), DelaySeconds: delaySeconds }));
}
export const dispatchHandler = createHistoryDispatcher({ enabled, send });
export const workHandler = (event: unknown, context?: { getRemainingTimeInMillis(): number }) =>
  createHistoryWorker({ enabled, send, process: async reference => {
    // Both configuration values are required before advancing a checkpoint.
    required('HISTORY_QUEUE_URL');
    const tableName = required('DYNAMODB_TABLE');
    const coordinator = new HistoryCoordinator(dynamodb, tableName), profiles = new ProfileNameWorker(dynamodb, tableName);
    return processHistorySteps(reference, ref => ref.kind === 'profile'
      ? (ref.key.startsWith('NAME#') ? profiles.process(ref) : new PlayerPortraitWorker(dynamodb, tableName, createPortraitStore()).process(ref))
      : coordinator.process(ref), {
      ...(context ? { remaining: () => context.getRemainingTimeInMillis() } : {})
    });
  } })(event);
