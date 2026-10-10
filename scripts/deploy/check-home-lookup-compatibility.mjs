// Read-only deployment preflight; source-owned version, never caller-supplied evidence.
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { DynamoDBClient, TransactGetItemsCommand } from '@aws-sdk/client-dynamodb';
import { HOME_LOOKUP_WRITER_VERSION } from '../../api/dist/data/home-league-writer-version.js';
import { validHomeLeagueCoverage } from '../../api/dist/data/home-league-coverage.js';
import { homeLeagueReaderSchema } from '../../api/dist/data/home-league-read.js';

export async function checkHomeLookupDeployment(client, tableName, readCurrentWriter) {
  const result = await client.send(new TransactGetItemsCommand({ TransactItems: ['CONTROL', 'READER'].map(sk => ({ Get: {
    TableName: tableName, Key: { pk: { S: 'HOME_LOOKUP' }, sk: { S: sk } },
  } })) }));
  if (result.Responses?.length !== 2) throw new Error('Home lookup deployment preflight needs reconciliation.');
  const parse = (item, type) => {
    if (!item) return null;
    if (item.entityType?.S !== type) throw new Error('Malformed home lookup control.');
    const value = JSON.parse(item.data?.S ?? 'null');
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Malformed home lookup control.');
    return value;
  };
  const coverage = parse(result.Responses[0].Item, 'homeLeagueCoverage');
  const rawReader = parse(result.Responses[1].Item, 'homeLeagueReader');
  const reader = rawReader === null ? null : homeLeagueReaderSchema.parse(rawReader);
  if (coverage && (!validHomeLeagueCoverage(coverage, tableName) || ['backfill', 'verification'].includes(coverage.phase)))
    throw new Error('Disable incomplete home coverage before deployment.');
  if (reader?.enabled && (!coverage || coverage.phase !== 'ready' || reader.coverageEpoch !== coverage.epoch))
    throw new Error('Disable inconsistent home reader and coverage before deployment.');
  if (coverage?.phase === 'ready') {
    const live = await readCurrentWriter();
    if (coverage.manifest.writerVersion !== HOME_LOOKUP_WRITER_VERSION ||
      live.homeLookupWriterVersion !== String(coverage.manifest.writerVersion) || live.tableName !== tableName ||
      !/^[a-f0-9]{40}$/.test(live.apiWriterSha ?? '') || live.state !== 'Active' || live.status !== 'Successful')
      throw new Error('Disable reader and coverage before an incompatible writer deployment.');
  }
}

async function main(env) {
  if (!['qa', 'prod'].includes(env)) throw new Error('Select qa or prod.');
  const region = process.env.AWS_REGION ?? 'ap-southeast-2';
  const client = new DynamoDBClient({ region });
  try {
    await checkHomeLookupDeployment(client, `3fc-${env}-app`, () => JSON.parse(execFileSync('aws', [
      'lambda', 'get-function-configuration', '--function-name', `3fc-${env}-api-core`, '--region', region,
      '--query', '{tableName:Environment.Variables.DYNAMODB_TABLE,homeLookupWriterVersion:Environment.Variables.HOME_LOOKUP_WRITER_VERSION,apiWriterSha:Environment.Variables.API_WRITER_SHA,state:State,status:LastUpdateStatus}', '--output', 'json',
    ], { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] })));
  } finally { client.destroy(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main(process.argv[2]).catch(() => { process.stderr.write('Home lookup preflight failed; inspect coverage and writer compatibility.\n'); process.exitCode = 1; });
