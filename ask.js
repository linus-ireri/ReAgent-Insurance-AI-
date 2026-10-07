import fetch from 'node-fetch';
import readline from 'readline';

function questionAsync(rl, q) {
  return new Promise((resolve) => rl.question(q, resolve));
}

// Create an input interface
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

(async () => {
  try {
    const question = (await questionAsync(rl, 'Ask your question: ')).trim();
    let claimIdRaw = (await questionAsync(rl, 'Claim ID (press Enter to skip): ')).trim();
    const claimId = claimIdRaw === '' ? undefined : claimIdRaw;

    const body = { question, claimId };

    let response;
    try {
      response = await fetch('http://localhost:3001/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (connErr) {
      console.error('\n==== ERROR: Server call failed ====');
      console.error('Could not connect to http://localhost:3001/agent');
      console.error('Error:', connErr.message);
      console.error('Make sure your server is running: node rag-server.js (or node server.js)');
      process.exit(1);
    }

    const text = await response.text();
    if (!response.ok) {
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (e) {
        parsed = text;
      }
      console.error('\n==== SERVER ERROR ====');
      console.error('Status:', response.status);
      console.error('Body:', typeof parsed === 'string' ? parsed : JSON.stringify(parsed, null, 2));
      process.exit(1);
    }

    const data = JSON.parse(text);

    // Sections
    console.log('\n========================================');
    console.log('==== AGENT REASONING TRACE');
    console.log('========================================');

    const trace = Array.isArray(data.trace) ? data.trace : [];
    if (!trace.length) {
      console.log('(No tools were called; the agent answered directly.)');
    } else {
      for (let i = 0; i < trace.length; i++) {
        const step = trace[i];
        console.log(`\nStep ${i + 1}: ${step.tool}`);
        console.log('Input:');
        try {
          console.log(JSON.stringify(step.input || {}, null, 2));
        } catch (e) {
          console.log(String(step.input));
        }

        console.log('Output:');
        const out = step.output;
        if (typeof out === 'string') {
          // Try parse JSON
          let parsed;
          try {
            parsed = JSON.parse(out);
          } catch (e) {
            parsed = null;
          }
          if (parsed) {
            console.log(JSON.stringify(parsed, null, 2));
          } else {
            const max = 400;
            if (out.length > max) {
              console.log(out.slice(0, max) + '\n[truncated]');
            } else {
              console.log(out);
            }
          }
        } else if (typeof out === 'object' && out !== null) {
          console.log(JSON.stringify(out, null, 2));
        } else {
          console.log(String(out));
        }
      }
    }

    console.log('\n========================================');
    console.log('==== FINAL ANSWER');
    console.log('========================================');
    console.log(data.answer || '[No answer returned]');

    console.log('\n========================================');
    console.log('==== SUMMARY');
    console.log('========================================');
    const calls = typeof data.raw_tool_calls_count === 'number' ? data.raw_tool_calls_count : trace.length;
    console.log(`Tools called: ${calls}`);

  } catch (err) {
    console.error('\n==== ERROR ====');
    console.error(err.message || String(err));
  } finally {
    rl.close();
  }
})();
