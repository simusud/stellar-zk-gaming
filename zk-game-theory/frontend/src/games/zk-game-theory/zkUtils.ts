import { Noir } from '@noir-lang/noir_js';
import { Barretenberg, UltraHonkBackend } from '@aztec/bb.js';
import { Buffer } from 'buffer';
import circuit from './circuit.json';
import circuitHash from './circuit_hash.json';

/**
 * ZK Utilities for the Prisoner's Dilemma game
 */
export class ZkUtils {
    private static noir: Noir | null = null;
    private static backend: UltraHonkBackend | null = null;
    private static hashNoir: Noir | null = null;

    /**
     * Initialize Noir and the backend
     */
    private static async init() {
        if (!this.noir || !this.backend) {
            this.backend = new UltraHonkBackend((circuit as any).bytecode);
            this.noir = new Noir(circuit as any);
        }
        if (!this.hashNoir) {
            this.hashNoir = new Noir(circuitHash as any);
        }
    }

    /**
     * Calculate a commitment hash (Pedersen) compatible with the Noir circuit.
     * Uses a dedicated hash-only Noir circuit executed via ACVM to avoid
     * bb.js browser serialization issues.
     */
    static async calculateCommitment(move: number, salt: string): Promise<string> {
        await this.init();

        // Format salt as a hex field string for Noir
        let saltHex = salt;
        if (!saltHex.startsWith('0x')) saltHex = '0x' + saltHex;

        console.log('[ZkUtils] Computing commitment via hash circuit, move:', move, 'salt:', saltHex);

        // Execute the hash-only circuit to compute pedersen_hash([move, salt])
        const result = await this.hashNoir!.execute({
            move_val: move,
            salt: saltHex
        });

        console.log('[ZkUtils] Hash circuit result:', result);

        // The return value is in result.returnValue
        const commitment = result.returnValue as string;
        console.log('[ZkUtils] Commitment:', commitment);

        return commitment;
    }

    /**
   * Generate a ZK proof for the commitment
   */
    static async generateProof(move: number, salt: string, commitment: string) {
        await this.init();

        const inputs = {
            move: move,
            salt: salt,
            commitment: commitment
        };

        console.log('[ZkUtils] Generating proof with inputs:', inputs);

        // 1. Execute to get witness
        console.log('[ZkUtils] Executing Noir program to get witness...');
        let witnessObject;
        try {
            witnessObject = await this.noir!.execute(inputs);
            console.log('[ZkUtils] Noir execution result keys:', Object.keys(witnessObject || {}));
        } catch (err: any) {
            console.error('[ZkUtils] Noir execute error:', err);
            throw err;
        }

        const witness = witnessObject.witness;
        console.log('[ZkUtils] Witness type:', typeof witness, witness ? 'length: ' + witness.length : 'undefined');

        // 2. Generate proof from witness using a FRESH backend instance
        // Barretenberg's UltraHonk WASM state gets corrupted if reused for multiple proofs
        // in the same browser session. We must instantiate and destroy it every time.
        console.log('[ZkUtils] Generating proof with backend (Keccak oracle)...');
        let proofData;
        const freshBackend = new UltraHonkBackend((circuit as any).bytecode);
        try {
            // Soroban verifier expects Keccak-flavored UltraHonk proofs
            proofData = await freshBackend.generateProof(witness, { keccak: true });
            console.log('[ZkUtils] Proof output type:', typeof proofData);
            if (proofData) {
                console.log('[ZkUtils] Proof output keys:', Object.keys(proofData));
                console.log('[ZkUtils] proofData.proof length:', proofData.proof.length);
                console.log('[ZkUtils] proofData.publicInputs length:', proofData.publicInputs.length);
            }
        } catch (err: any) {
            console.error('[ZkUtils] Backend generateProof error:', err);
            throw err;
        } finally {
            // Memory management: clean up the WASM instance to prevent leaks
            try {
                await freshBackend.destroy();
                console.log('[ZkUtils] Fresh backend destroyed.');
            } catch (destroyErr) {
                console.error('[ZkUtils] Error destroying backend:', destroyErr);
            }
        }

        console.log('[ZkUtils] Proof generated successfully');

        return proofData.proof;
    }
}
