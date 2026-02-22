import { Buffer } from "buffer";
import { Address } from "@stellar/stellar-sdk";
import {
  AssembledTransaction,
  Client as ContractClient,
  ClientOptions as ContractClientOptions,
  MethodOptions,
  Result,
  Spec as ContractSpec,
} from "@stellar/stellar-sdk/contract";
import type {
  u32,
  i32,
  u64,
  i64,
  u128,
  i128,
  u256,
  i256,
  Option,
  Timepoint,
  Duration,
} from "@stellar/stellar-sdk/contract";
export * from "@stellar/stellar-sdk";
export * as contract from "@stellar/stellar-sdk/contract";
export * as rpc from "@stellar/stellar-sdk/rpc";

if (typeof window !== "undefined") {
  //@ts-ignore Buffer exists
  window.Buffer = window.Buffer || Buffer;
}


export const networks = {
  testnet: {
    networkPassphrase: "Test SDF Network ; September 2015",
    contractId: "CDUSVXKU7IZ7CLAPTF5FZMZKBPRYETO3ZP6WKLJYCVWJ5JQQNQ6TQCDF",
  }
} as const


export interface Game {
  current_round: u32;
  is_complete: boolean;
  p1_commitments: Map<u32, Buffer>;
  p1_moves: Map<u32, u32>;
  p1_score: u32;
  p2_commitments: Map<u32, Buffer>;
  p2_moves: Map<u32, u32>;
  p2_score: u32;
  player1: string;
  player2: string;
}

export const Errors = {
  1: {message:"GameNotFound"},
  2: {message:"NotPlayer"},
  3: {message:"AlreadyCommitted"},
  4: {message:"BothPlayersNotCommitted"},
  5: {message:"GameAlreadyEnded"},
  6: {message:"InvalidMove"},
  7: {message:"VerificationFailed"},
  8: {message:"VkNotSet"},
  9: {message:"AlreadyRevealed"}
}

export type DataKey = {tag: "Game", values: readonly [u32]} | {tag: "GameHubAddress", values: void} | {tag: "Admin", values: void} | {tag: "VerificationKey", values: void} | {tag: "NativeToken", values: void} | {tag: "Treasury", values: void};

export interface Client {
  /**
   * Construct and simulate a upgrade transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  upgrade: ({new_wasm_hash}: {new_wasm_hash: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a get_game transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_game: ({session_id}: {session_id: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Result<Game>>>

  /**
   * Construct and simulate a get_admin transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_admin: (options?: MethodOptions) => Promise<AssembledTransaction<string>>

  /**
   * Construct and simulate a start_game transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  start_game: ({session_id, player1, player2, player1_points, player2_points}: {session_id: u32, player1: string, player2: string, player1_points: i128, player2_points: i128}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a commit_move transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Players commit a hash of their move (0 for Cooperate, 1 for Defect)
   */
  commit_move: ({session_id, player, commitment}: {session_id: u32, player: string, commitment: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a reveal_move transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Reveal move with ZK proof
   */
  reveal_move: ({session_id, player, move_val, proof}: {session_id: u32, player: string, move_val: u32, proof: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a set_verification_key transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  set_verification_key: ({vk}: {vk: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

}
export class Client extends ContractClient {
  static async deploy<T = Client>(
        /** Constructor/Initialization Args for the contract's `__constructor` method */
        {admin, game_hub, vk, native_token, treasury}: {admin: string, game_hub: string, vk: Buffer, native_token: string, treasury: string},
    /** Options for initializing a Client as well as for calling a method, with extras specific to deploying. */
    options: MethodOptions &
      Omit<ContractClientOptions, "contractId"> & {
        /** The hash of the Wasm blob, which must already be installed on-chain. */
        wasmHash: Buffer | string;
        /** Salt used to generate the contract's ID. Passed through to {@link Operation.createCustomContract}. Default: random. */
        salt?: Buffer | Uint8Array;
        /** The format used to decode `wasmHash`, if it's provided as a string. */
        format?: "hex" | "base64";
      }
  ): Promise<AssembledTransaction<T>> {
    return ContractClient.deploy({admin, game_hub, vk, native_token, treasury}, options)
  }
  constructor(public readonly options: ContractClientOptions) {
    super(
      new ContractSpec([ "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" ]),
      options
    )
  }
  public readonly fromJSON = {
    upgrade: this.txFromJSON<null>,
        get_game: this.txFromJSON<Result<Game>>,
        get_admin: this.txFromJSON<string>,
        start_game: this.txFromJSON<Result<void>>,
        commit_move: this.txFromJSON<Result<void>>,
        reveal_move: this.txFromJSON<Result<void>>,
        set_verification_key: this.txFromJSON<null>
  }
}