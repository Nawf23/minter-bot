const WebSocket = require('ws');
const ws = new WebSocket('wss://eth-mainnet.g.alchemy.com/v2/t81_VvmzL9xx7yRgDGs1t');

ws.on('open', () => {
    console.log('Connected');
    ws.send(JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_subscribe',
        params: [
            'alchemy_pendingTransactions',
            { 
                hashesOnly: false
            }
        ]
    }));
});

let count = 0;
let stringCount = 0;
ws.on('message', (data) => {
    const msg = JSON.parse(data);
    if (msg.method === 'eth_subscription') {
        count++;
        if (typeof msg.params.result === 'string') {
            stringCount++;
            console.log('Got string Instead of object:', msg.params.result);
        } else {
            console.log('Got object:', msg.params.result?.hash);
        }
        if (count > 2) process.exit(0);
    } else {
        console.log(msg);
    }
});
