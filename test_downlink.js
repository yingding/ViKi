
const http = require('http');

const options = {
  hostname: 'localhost',
  port: 7071,
  path: '/api/consults/0-0/voice-listen',
  method: 'GET',
  headers: {
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  }
};

console.log(`Connecting to http://${options.hostname}:${options.port}${options.path}...`);

const req = http.request(options, (res) => {
  console.log(`STATUS: ${res.statusCode}`);
  console.log(`HEADERS: ${JSON.stringify(res.headers)}`);
  
  res.on('data', (chunk) => {
    console.log(`BODY: Received chunk of ${chunk.length} bytes`);
  });

  res.on('end', () => {
    console.log('No more data in response.');
  });
});

req.on('error', (e) => {
  console.error(`problem with request: ${e.message}`);
});

req.end();
