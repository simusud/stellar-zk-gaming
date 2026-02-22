#![no_std]

extern crate alloc;

use soroban_sdk::{
    Address, Bytes, BytesN, Env, IntoVal, contract, contractclient, contracterror, contractimpl, contracttype, vec, Map, token
};
use ultrahonk_soroban_verifier::UltraHonkVerifier;

// Import GameHub contract interface
#[contractclient(name = "GameHubClient")]
pub trait GameHub {
    fn start_game(
        env: Env,
        game_id: Address,
        session_id: u32,
        player1: Address,
        player2: Address,
        player1_points: i128,
        player2_points: i128,
    );

    fn end_game(
        env: Env,
        session_id: u32,
        player1_won: bool
    );
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    GameNotFound = 1,
    NotPlayer = 2,
    AlreadyCommitted = 3,
    BothPlayersNotCommitted = 4,
    GameAlreadyEnded = 5,
    InvalidMove = 6,
    VerificationFailed = 7,
    VkNotSet = 8,
    AlreadyRevealed = 9,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Game {
    pub player1: Address,
    pub player2: Address,
    pub p1_commitments: Map<u32, BytesN<32>>,
    pub p2_commitments: Map<u32, BytesN<32>>,
    pub p1_moves: Map<u32, u32>,
    pub p2_moves: Map<u32, u32>,
    pub p1_score: u32,
    pub p2_score: u32,
    pub current_round: u32,
    pub is_complete: bool,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Game(u32),
    GameHubAddress,
    Admin,
    VerificationKey,
    NativeToken,
    Treasury,
}

const GAME_TTL_LEDGERS: u32 = 518_400;

#[contract]
pub struct ZkGameTheoryContract;

#[contractimpl]
impl ZkGameTheoryContract {
    pub fn __constructor(env: Env, admin: Address, game_hub: Address, vk: Bytes, native_token: Address, treasury: Address) {
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::GameHubAddress, &game_hub);
        env.storage().instance().set(&DataKey::VerificationKey, &vk);
        env.storage().instance().set(&DataKey::NativeToken, &native_token);
        env.storage().instance().set(&DataKey::Treasury, &treasury);
    }

    pub fn set_verification_key(env: Env, vk: Bytes) {
        let admin: Address = env.storage().instance().get(&DataKey::Admin).expect("Admin not set");
        admin.require_auth();
        env.storage().instance().set(&DataKey::VerificationKey, &vk);
    }

    pub fn start_game(
        env: Env,
        session_id: u32,
        player1: Address,
        player2: Address,
        player1_points: i128,
        player2_points: i128,
    ) -> Result<(), Error> {
        if player1 == player2 {
            panic!("Cannot play against yourself");
        }

        player1.require_auth_for_args(vec![&env, session_id.into_val(&env), player1_points.into_val(&env)]);
        player2.require_auth_for_args(vec![&env, session_id.into_val(&env), player2_points.into_val(&env)]);

        let native_token: Address = env.storage().instance().get(&DataKey::NativeToken).expect("NativeToken not set");
        let token_client = token::Client::new(&env, &native_token);
        
        // Transfer 10 XLM = 100_000_000 stroops from each player
        let entry_fee = 100_000_000i128;
        token_client.transfer(&player1, &env.current_contract_address(), &entry_fee);
        token_client.transfer(&player2, &env.current_contract_address(), &entry_fee);

        let game_hub_addr: Address = env.storage().instance().get(&DataKey::GameHubAddress).expect("GameHub address not set");
        let game_hub = GameHubClient::new(&env, &game_hub_addr);

        game_hub.start_game(
            &env.current_contract_address(),
            &session_id,
            &player1,
            &player2,
            &player1_points,
            &player2_points,
        );

        let game = Game {
            player1: player1.clone(),
            player2: player2.clone(),
            p1_commitments: Map::<u32, BytesN<32>>::new(&env),
            p2_commitments: Map::<u32, BytesN<32>>::new(&env),
            p1_moves: Map::<u32, u32>::new(&env),
            p2_moves: Map::<u32, u32>::new(&env),
            p1_score: 0,
            p2_score: 0,
            current_round: 1,
            is_complete: false,
        };

        let game_key = DataKey::Game(session_id);
        env.storage().temporary().set(&game_key, &game);
        env.storage().temporary().extend_ttl(&game_key, GAME_TTL_LEDGERS, GAME_TTL_LEDGERS);

        Ok(())
    }

    /// Players commit a hash of their move (0 for Cooperate, 1 for Defect)
    pub fn commit_move(env: Env, session_id: u32, player: Address, commitment: BytesN<32>) -> Result<(), Error> {
        player.require_auth();

        let key = DataKey::Game(session_id);
        let mut game: Game = env.storage().temporary().get(&key).ok_or(Error::GameNotFound)?;

        if game.is_complete {
            return Err(Error::GameAlreadyEnded);
        }

        let round = game.current_round;

        if player == game.player1 {
            if game.p1_commitments.contains_key(round) { return Err(Error::AlreadyCommitted); }
            game.p1_commitments.set(round, commitment);
        } else if player == game.player2 {
            if game.p2_commitments.contains_key(round) { return Err(Error::AlreadyCommitted); }
            game.p2_commitments.set(round, commitment);
        } else {
            return Err(Error::NotPlayer);
        }

        env.storage().temporary().set(&key, &game);
        Ok(())
    }

    /// Reveal move with ZK proof
    pub fn reveal_move(
        env: Env, 
        session_id: u32, 
        player: Address, 
        move_val: u32, 
        proof: Bytes
    ) -> Result<(), Error> {
        player.require_auth();

        let key = DataKey::Game(session_id);
        let mut game: Game = env.storage().temporary().get(&key).ok_or(Error::GameNotFound)?;

        if game.is_complete {
            return Err(Error::GameAlreadyEnded);
        }

        let round = game.current_round;

        let commitment = if player == game.player1 {
            if game.p1_moves.contains_key(round) { return Err(Error::AlreadyRevealed); }
            game.p1_commitments.get(round).ok_or(Error::BothPlayersNotCommitted)?
        } else if player == game.player2 {
            if game.p2_moves.contains_key(round) { return Err(Error::AlreadyRevealed); }
            game.p2_commitments.get(round).ok_or(Error::BothPlayersNotCommitted)?
        } else {
            return Err(Error::NotPlayer);
        };

        // ZK Verification
        let vk_bytes: Bytes = env.storage().instance().get(&DataKey::VerificationKey).ok_or(Error::VkNotSet)?;
        let verifier = UltraHonkVerifier::new(&env, &vk_bytes).map_err(|_| Error::VerificationFailed)?;
        
        // Public inputs: [commitment]
        let mut public_inputs = Bytes::new(&env);
        public_inputs.append(&commitment.clone().into());

        // Proof Slicing
        let proof_len = proof.len();
        let actual_proof = if proof_len == 14592 {
            proof
        } else if proof_len > 14592 {
            proof.slice((proof_len - 14592)..)
        } else {
            proof
        };
        
        verifier.verify(&actual_proof, &public_inputs).map_err(|_| Error::VerificationFailed)?;

        // Update move
        if player == game.player1 {
            game.p1_moves.set(round, move_val);
        } else {
            game.p2_moves.set(round, move_val);
        }

        // Deterministic winner/payout calculation if both revealed
        if game.p1_moves.contains_key(round) && game.p2_moves.contains_key(round) {
            let m1 = game.p1_moves.get(round).unwrap();
            let m2 = game.p2_moves.get(round).unwrap();

            // 0: Cooperate, 1: Defect
            match (m1, m2) {
                (0, 0) => { game.p1_score += 3; game.p2_score += 3; },
                (1, 1) => { game.p1_score += 1; game.p2_score += 1; },
                (0, 1) => { game.p1_score += 0; game.p2_score += 5; },
                (1, 0) => { game.p1_score += 5; game.p2_score += 0; },
                _ => panic!("Invalid move state"),
            };

            if game.current_round == 5 {
                game.is_complete = true;
                Self::finalize_game_internal(&env, session_id, &game)?;
            } else {
                game.current_round += 1;
            }
        }

        env.storage().temporary().set(&key, &game);

        Ok(())
    }

    fn finalize_game_internal(env: &Env, session_id: u32, game: &Game) -> Result<(), Error> {
        let native_token: Address = env.storage().instance().get(&DataKey::NativeToken).unwrap();
        let treasury: Address = env.storage().instance().get(&DataKey::Treasury).unwrap();
        let token_client = token::Client::new(env, &native_token);

        // 1 point = 0.3 XLM = 3_000_000 stroops
        let point_value = 3_000_000i128;
        let p1_payout = (game.p1_score as i128) * point_value;
        let p2_payout = (game.p2_score as i128) * point_value;

        let contract_address = env.current_contract_address();

        if p1_payout > 0 {
            token_client.transfer(&contract_address, &game.player1, &p1_payout);
        }
        if p2_payout > 0 {
            token_client.transfer(&contract_address, &game.player2, &p2_payout);
        }

        // Send remaining balance to treasury (entry was 20 XLM = 200_000_000)
        let total_paid = p1_payout + p2_payout;
        let total_pool = 200_000_000i128;
        if total_pool > total_paid {
            let treasury_payout = total_pool - total_paid;
            token_client.transfer(&contract_address, &treasury, &treasury_payout);
        }

        let player1_won = game.p1_score >= game.p2_score;

        let game_hub_addr: Address = env.storage().instance().get(&DataKey::GameHubAddress).expect("GameHub address not set");
        let game_hub = GameHubClient::new(env, &game_hub_addr);
        game_hub.end_game(&session_id, &player1_won);

        Ok(())
    }

    pub fn get_game(env: Env, session_id: u32) -> Result<Game, Error> {
        let key = DataKey::Game(session_id);
        env.storage().temporary().get(&key).ok_or(Error::GameNotFound)
    }

    pub fn get_admin(env: Env) -> Address {
        env.storage().instance().get(&DataKey::Admin).expect("Admin not set")
    }

    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) {
        let admin: Address = env.storage().instance().get(&DataKey::Admin).expect("Admin not set");
        admin.require_auth();
        env.deployer().update_current_contract_wasm(new_wasm_hash);
    }
}
