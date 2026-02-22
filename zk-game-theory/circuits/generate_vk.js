import { UltraHonkBackend } from '@aztec/bb.js';
import { readFileSync, writeFileSync } from 'fs';
import { Buffer } from 'buffer';

async function main() {
    try {
        const circuitJson = JSON.parse(readFileSync('./target/circuits.json', 'utf8'));
        const bytecode = circuitJson.bytecode;

        console.log('Generating VK for UltraHonk...');
        const backend = new UltraHonkBackend(bytecode);

        const vk = await backend.getVerificationKey();

        console.log('VK generated, size:', vk.length);

        // Save VK as binary
        writeFileSync('./target/vk.bin', Buffer.from(vk));

        // Save VK as hex string for easy copy-pasting if needed
        const vkHex = Buffer.from(vk).toString('hex');
        writeFileSync('./target/vk.hex', vkHex);

        console.log('VK saved to ./target/vk.bin and ./target/vk.hex');

        await backend.destroy();
    } catch (err) {
        console.error('Error generating VK:', err);
        process.exit(1);
    }
}

main();
