import { getRegisterEntries } from './lib/qbo-evidence-register';

async function main() {
  const entries = await getRegisterEntries('sandbox_company');
  console.log('Total entries:', entries.length);
  entries.forEach(e => console.log(e.qboTxnId, e.registerState, e.attachmentFilename));
}

main().catch(console.error);