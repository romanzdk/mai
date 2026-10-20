import { startServer } from './server';

const token = process.env.MAI_TOKEN;
if (!token) {
  console.error('MAI_TOKEN is required');
  process.exit(1);
}

const server = await startServer({ token, port: Number(process.env.MAI_PORT ?? 0) });
// The Tauri host parses this line to learn the port; keep the format in sync with lib.rs.
console.log(`MAI_DAEMON_READY ${JSON.stringify({ port: server.port })}`);

// The host keeps our stdin open; EOF means it died without killing us.
if (process.env.MAI_EXIT_ON_STDIN_EOF === '1') {
  process.stdin.on('end', () => process.exit(0));
  process.stdin.resume();
}
