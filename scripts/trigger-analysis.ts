import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';

const PORT = process.env.PORT || 3001;
const BASE_URL = `http://localhost:${PORT}`;

async function main() {
  const fixturePath = process.argv[2]
    ? path.resolve(process.argv[2])
    : path.resolve(__dirname, '../test/fixtures/sample-analysis.json');

  if (!fs.existsSync(fixturePath)) {
    console.error(`Fixture file not found: ${fixturePath}`);
    process.exit(1);
  }

  const analysis = JSON.parse(fs.readFileSync(fixturePath, 'utf-8'));

  console.log(`Triggering analysis ID ${analysis.id} (${analysis.name}) [${analysis.assembly}]`);
  console.log(`  Upload: ${analysis.upload?.original_name}`);
  console.log(`  Endpoint: POST ${BASE_URL}/vcf/trigger\n`);

  try {
    const { data, status } = await axios.post(`${BASE_URL}/vcf/trigger`, analysis, {
      headers: { 'Content-Type': 'application/json' },
    });
    console.log(`Response ${status}:`, data);
    console.log('\nAnalysis is running in the background. Check the server logs for progress.');
  } catch (error: any) {
    if (error.response) {
      console.error(`Error ${error.response.status}:`, error.response.data);
    } else {
      console.error('Could not reach server:', error.message);
      console.error('Make sure the app is running: npm run start:dev');
    }
    process.exit(1);
  }
}

main();
