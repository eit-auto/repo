const Service = require('node-windows').Service;
const path = require('path');

console.log('Starting RewstProxy service installation...');

let svc = new Service({
  name: 'RewstProxy',
  description: 'Rewst MeshCentral HTTPS Proxy',
  script: path.join(__dirname, 'proxy.js'),
  nodeOptions: '--max-old-space-size=512'
});

svc.on('install', () => {
  console.log('✓ RewstProxy service installed');
  svc.start();
});

svc.on('start', () => {
  console.log('✓ RewstProxy service started');
});

svc.on('error', (err) => {
  console.error('✗ Service error:', err);
});

console.log('Installing service...');
svc.install();
console.log('Installation command sent');