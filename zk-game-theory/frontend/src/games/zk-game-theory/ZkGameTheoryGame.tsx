import { useState, useEffect, useRef } from 'react';
import { ZkGameTheoryService } from './zkGameTheoryService';
import { requestCache, createCacheKey } from '@/utils/requestCache';
import { useWallet } from '@/hooks/useWallet';
import { ZK_GAME_THEORY_CONTRACT } from '@/utils/constants';
import { getFundedSimulationSourceAddress } from '@/utils/simulationUtils';
import { devWalletService, DevWalletService } from '@/services/devWalletService';
import type { Game } from './bindings/src';

const createRandomSessionId = (): number => {
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    let value = 0;
    const buffer = new Uint32Array(1);
    while (value === 0) {
      crypto.getRandomValues(buffer);
      value = buffer[0];
    }
    return value;
  }

  return (Math.floor(Math.random() * 0xffffffff) >>> 0) || 1;
};

// Create service instance with the contract ID
const zkGameTheoryService = new ZkGameTheoryService(ZK_GAME_THEORY_CONTRACT);

interface ZkGameTheoryGameProps {
  userAddress: string;
  currentEpoch: number;
  availablePoints: bigint;
  initialXDR?: string | null;
  initialSessionId?: number | null;
  onStandingsRefresh: () => void;
  onGameComplete: () => void;
}

export function ZkGameTheoryGame({
  userAddress,
  availablePoints,
  initialXDR,
  initialSessionId,
  onStandingsRefresh,
  onGameComplete
}: ZkGameTheoryGameProps) {
  const DEFAULT_POINTS = '10.0';
  const { getContractSigner, walletType } = useWallet();
  // Use a random session ID that fits in u32 (avoid 0 because UI validation treats <=0 as invalid)
  const [sessionId, setSessionId] = useState<number>(() => createRandomSessionId());
  const [player1Address, setPlayer1Address] = useState(userAddress);
  const [player1Points, setPlayer1Points] = useState(DEFAULT_POINTS);
  const [guess, setGuess] = useState<number | null>(null); // 0: Cooperate, 1: Defect
  const [salt, setSalt] = useState<string>('');
  const [gameState, setGameState] = useState<Game | null>(null);
  const [loading, setLoading] = useState(false);
  const [quickstartLoading, setQuickstartLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [gamePhase, setGamePhase] = useState<'create' | 'guess' | 'reveal' | 'complete'>('create');
  const [createMode, setCreateMode] = useState<'create' | 'import' | 'load'>('create');
  const [exportedAuthEntryXDR, setExportedAuthEntryXDR] = useState<string | null>(null);
  const [importAuthEntryXDR, setImportAuthEntryXDR] = useState('');
  const [importSessionId, setImportSessionId] = useState('');
  const [importPlayer1, setImportPlayer1] = useState('');
  const [importPlayer1Points, setImportPlayer1Points] = useState('');
  const [importPlayer2Points, setImportPlayer2Points] = useState(DEFAULT_POINTS);
  const [loadSessionId, setLoadSessionId] = useState('');
  const [authEntryCopied, setAuthEntryCopied] = useState(false);
  const [shareUrlCopied, setShareUrlCopied] = useState(false);
  const [xdrParsing, setXdrParsing] = useState(false);
  const [xdrParseError, setXdrParseError] = useState<string | null>(null);
  const [xdrParseSuccess, setXdrParseSuccess] = useState(false);

  useEffect(() => {
    setPlayer1Address(userAddress);
  }, [userAddress]);

  useEffect(() => {
    if (createMode === 'import' && !importPlayer2Points.trim()) {
      setImportPlayer2Points(DEFAULT_POINTS);
    }
  }, [createMode, importPlayer2Points]);

  const POINTS_DECIMALS = 7;
  const isBusy = loading || quickstartLoading;
  const actionLock = useRef(false);
  const quickstartAvailable = walletType === 'dev'
    && DevWalletService.isDevModeAvailable()
    && DevWalletService.isPlayerAvailable(1)
    && DevWalletService.isPlayerAvailable(2);

  const runAction = async (action: () => Promise<void>) => {
    if (actionLock.current || isBusy) {
      return;
    }
    actionLock.current = true;
    try {
      await action();
    } finally {
      actionLock.current = false;
    }
  };

  const handleStartNewGame = () => {
    if (gameState?.is_complete) {
      onGameComplete();
    }

    actionLock.current = false;
    setGamePhase('create');
    setSessionId(createRandomSessionId());
    setGameState(null);
    setGuess(null);
    setLoading(false);
    setQuickstartLoading(false);
    setError(null);
    setSuccess(null);
    setCreateMode('create');
    setExportedAuthEntryXDR(null);
    setImportAuthEntryXDR('');
    setImportSessionId('');
    setImportPlayer1('');
    setImportPlayer1Points('');
    setImportPlayer2Points(DEFAULT_POINTS);
    setLoadSessionId('');
    setAuthEntryCopied(false);
    setShareUrlCopied(false);
    setXdrParsing(false);
    setXdrParseError(null);
    setXdrParseSuccess(false);
    setPlayer1Address(userAddress);
    setPlayer1Points(DEFAULT_POINTS);
  };

  const parsePoints = (value: string): bigint | null => {
    try {
      const cleaned = value.replace(/[^\d.]/g, '');
      if (!cleaned || cleaned === '.') return null;

      const [whole = '0', fraction = ''] = cleaned.split('.');
      const paddedFraction = fraction.padEnd(POINTS_DECIMALS, '0').slice(0, POINTS_DECIMALS);
      return BigInt(whole + paddedFraction);
    } catch {
      return null;
    }
  };

  const loadGameState = async () => {
    try {
      const game = await zkGameTheoryService.getGame(sessionId);
      setGameState(game as any);

      // Restore salt and guess if we have them for this session, otherwise expressly clear them to prevent cross-account leakage
      if (userAddress) {
        const savedSalt = localStorage.getItem(`zk_salt_${sessionId}_${userAddress}`);
        setSalt(savedSalt || '');

        const savedGuess = localStorage.getItem(`zk_guess_${sessionId}_${userAddress}`);
        if (savedGuess !== null) {
          setGuess(parseInt(savedGuess, 10));
        } else {
          setGuess(null);
        }
      } else {
        setSalt('');
        setGuess(null);
      }

      // Determine game phase based on state
      if (game) {
        if (game.is_complete) {
          setGamePhase('complete');
        } else {
          const currentRound = game.current_round;

          const getMapValue = (mapVal: any, key: number) => {
            if (!mapVal) return undefined;
            if (mapVal instanceof Map) return mapVal.get(key);
            if (Array.isArray(mapVal)) {
              const entry = mapVal.find((e: any) => e[0] === key || e.key === key);
              if (!entry) return undefined;
              return typeof entry[1] !== 'undefined' ? entry[1] : entry.value;
            }
            return undefined;
          };

          const p1Comm = getMapValue(game.p1_commitments, currentRound);
          const p2Comm = getMapValue(game.p2_commitments, currentRound);

          if (p1Comm && p2Comm) {
            setGamePhase('reveal');
          } else {
            setGamePhase('guess');
          }
        }
      } else {
        setGamePhase('guess');
      }
    } catch (err) {
      setGameState(null);
    }
  };

  useEffect(() => {
    if (gamePhase !== 'create') {
      loadGameState();
      const interval = setInterval(loadGameState, 5000); // Poll every 5 seconds
      return () => clearInterval(interval);
    }
  }, [sessionId, gamePhase, userAddress]);

  // Auto-refresh standings when game completes (for passive player who didn't call reveal_winner)
  useEffect(() => {
    if (gamePhase === 'complete' && gameState?.is_complete) {
      console.log('Game completed! Refreshing standings and dashboard data...');
      onStandingsRefresh(); // Refresh standings and available points; don't call onGameComplete() here or it will close the game!
    }
  }, [gamePhase, gameState?.is_complete]);

  // Handle initial values from URL deep linking or props
  // Expected URL formats:
  //   - With auth entry: ?game=zk-game-theory&auth=AAAA... (Session ID, P1 address, P1 points parsed from auth entry)
  //   - With session ID: ?game=zk-game-theory&session-id=123 (Load existing game)
  // Note: GamesCatalog cleans URL params, so we prioritize props over URL
  useEffect(() => {
    // Priority 1: Check initialXDR prop (from GamesCatalog after URL cleanup)
    if (initialXDR) {
      console.log('[Deep Link] Using initialXDR prop from GamesCatalog');

      try {
        const parsed = zkGameTheoryService.parseAuthEntry(initialXDR);
        const sessionId = parsed.sessionId;

        console.log('[Deep Link] Parsed session ID from initialXDR:', sessionId);

        // Check if game already exists (both players have signed)
        zkGameTheoryService.getGame(sessionId)
          .then((game) => {
            if (game) {
              // Game exists! Load it directly instead of going to import mode
              console.log('[Deep Link] Game already exists, loading directly to guess phase');
              console.log('[Deep Link] Game data:', game);

              // Auto-load the game - bypass create phase entirely
              setGameState(game);
              setGamePhase('guess');
              setSessionId(sessionId); // Set session ID for the game
            } else {
              // Game doesn't exist yet, go to import mode
              console.log('[Deep Link] Game not found, entering import mode');
              setCreateMode('import');
              setImportAuthEntryXDR(initialXDR);
              setImportSessionId(sessionId.toString());
              setImportPlayer1(parsed.player1);
              setImportPlayer1Points((Number(parsed.player1Points) / 10_000_000).toString());
              setImportPlayer2Points('10.0');
            }
          })
          .catch((err) => {
            console.error('[Deep Link] Error checking game existence:', err);
            console.error('[Deep Link] Error details:', {
              message: err?.message,
              stack: err?.stack,
              sessionId: sessionId,
            });
            // If we can't check, default to import mode
            setCreateMode('import');
            setImportAuthEntryXDR(initialXDR);
            setImportSessionId(parsed.sessionId.toString());
            setImportPlayer1(parsed.player1);
            setImportPlayer1Points((Number(parsed.player1Points) / 10_000_000).toString());
            setImportPlayer2Points('10.0');
          });
      } catch (err) {
        console.log('[Deep Link] Failed to parse initialXDR, will retry on import');
        setCreateMode('import');
        setImportAuthEntryXDR(initialXDR);
        setImportPlayer2Points('10.0');
      }
      return; // Exit early - we processed initialXDR
    }

    // Priority 2: Check URL parameters (for direct navigation without GamesCatalog)
    const urlParams = new URLSearchParams(window.location.search);
    const authEntry = urlParams.get('auth');
    const urlSessionId = urlParams.get('session-id');

    if (authEntry) {
      // Simplified URL format - only auth entry is needed
      // Session ID, Player 1 address, and points are parsed from auth entry
      console.log('[Deep Link] Auto-populating game from URL with auth entry');

      // Try to parse auth entry to get session ID
      try {
        const parsed = zkGameTheoryService.parseAuthEntry(authEntry);
        const sessionId = parsed.sessionId;

        console.log('[Deep Link] Parsed session ID from URL auth entry:', sessionId);

        // Check if game already exists (both players have signed)
        zkGameTheoryService.getGame(sessionId)
          .then((game) => {
            if (game) {
              // Game exists! Load it directly instead of going to import mode
              console.log('[Deep Link] Game already exists (URL), loading directly to guess phase');
              console.log('[Deep Link] Game data:', game);

              // Auto-load the game - bypass create phase entirely
              setGameState(game);
              setGamePhase('guess');
              setSessionId(sessionId); // Set session ID for the game
            } else {
              // Game doesn't exist yet, go to import mode
              console.log('[Deep Link] Game not found (URL), entering import mode');
              setCreateMode('import');
              setImportAuthEntryXDR(authEntry);
              setImportSessionId(sessionId.toString());
              setImportPlayer1(parsed.player1);
              setImportPlayer1Points((Number(parsed.player1Points) / 10_000_000).toString());
              setImportPlayer2Points('10.0');
            }
          })
          .catch((err) => {
            console.error('[Deep Link] Error checking game existence (URL):', err);
            console.error('[Deep Link] Error details:', {
              message: err?.message,
              stack: err?.stack,
              sessionId: sessionId,
            });
            // If we can't check, default to import mode
            setCreateMode('import');
            setImportAuthEntryXDR(authEntry);
            setImportSessionId(parsed.sessionId.toString());
            setImportPlayer1(parsed.player1);
            setImportPlayer1Points((Number(parsed.player1Points) / 10_000_000).toString());
            setImportPlayer2Points('10.0');
          });
      } catch (err) {
        console.log('[Deep Link] Failed to parse auth entry from URL, will retry on import');
        setCreateMode('import');
        setImportAuthEntryXDR(authEntry);
        setImportPlayer2Points('10.0');
      }
    } else if (urlSessionId) {
      // Load existing game by session ID
      console.log('[Deep Link] Auto-populating game from URL with session ID');
      setCreateMode('load');
      setLoadSessionId(urlSessionId);
    } else if (initialSessionId !== null && initialSessionId !== undefined) {
      console.log('[Deep Link] Auto-populating session ID from prop:', initialSessionId);
      setCreateMode('load');
      setLoadSessionId(initialSessionId.toString());
    }
  }, [initialXDR, initialSessionId]);

  // Auto-parse Auth Entry XDR when pasted
  useEffect(() => {
    // Only parse if in import mode and XDR is not empty
    if (createMode !== 'import' || !importAuthEntryXDR.trim()) {
      // Reset parse states when XDR is cleared
      if (!importAuthEntryXDR.trim()) {
        setXdrParsing(false);
        setXdrParseError(null);
        setXdrParseSuccess(false);
        setImportSessionId('');
        setImportPlayer1('');
        setImportPlayer1Points('');
      }
      return;
    }

    // Auto-parse the XDR
    const parseXDR = async () => {
      setXdrParsing(true);
      setXdrParseError(null);
      setXdrParseSuccess(false);

      try {
        console.log('[Auto-Parse] Parsing auth entry XDR...');
        const gameParams = zkGameTheoryService.parseAuthEntry(importAuthEntryXDR.trim());

        // Check if user is trying to import their own auth entry (self-play prevention)
        if (gameParams.player1 === userAddress) {
          throw new Error('You cannot play against yourself. This auth entry was created by you (Player 1).');
        }

        // Successfully parsed - auto-fill fields
        setImportSessionId(gameParams.sessionId.toString());
        setImportPlayer1(gameParams.player1);
        setImportPlayer1Points((Number(gameParams.player1Points) / 10_000_000).toString());
        setXdrParseSuccess(true);
        console.log('[Auto-Parse] Successfully parsed auth entry:', {
          sessionId: gameParams.sessionId,
          player1: gameParams.player1,
          player1Points: (Number(gameParams.player1Points) / 10_000_000).toString(),
        });
      } catch (err) {
        console.error('[Auto-Parse] Failed to parse auth entry:', err);
        const errorMsg = err instanceof Error ? err.message : 'Invalid auth entry XDR';
        setXdrParseError(errorMsg);
        // Clear auto-filled fields on error
        setImportSessionId('');
        setImportPlayer1('');
        setImportPlayer1Points('');
      } finally {
        setXdrParsing(false);
      }
    };

    // Debounce parsing to avoid parsing on every keystroke
    const timeoutId = setTimeout(parseXDR, 500);
    return () => clearTimeout(timeoutId);
  }, [importAuthEntryXDR, createMode, userAddress]);

  const handlePrepareTransaction = async () => {
    await runAction(async () => {
      try {
        setLoading(true);
        setError(null);
        setSuccess(null);

        const p1Points = parsePoints(player1Points);

        if (!p1Points || p1Points <= 0n) {
          throw new Error('Enter a valid points amount');
        }

        const signer = getContractSigner();

        // Use placeholder values for Player 2 (they'll rebuild with their own values).
        // We still need a real, funded account as the transaction source for build/simulation.
        const placeholderPlayer2Address = await getFundedSimulationSourceAddress([player1Address, userAddress]);
        const placeholderP2Points = p1Points; // Same as P1 for simulation

        console.log('Preparing transaction for Player 1 to sign...');
        console.log('Using placeholder Player 2 values for simulation only');
        const authEntryXDR = await zkGameTheoryService.prepareStartGame(
          sessionId,
          player1Address,
          placeholderPlayer2Address,
          p1Points,
          placeholderP2Points,
          signer
        );

        console.log('Transaction prepared successfully! Player 1 has signed their auth entry.');
        setExportedAuthEntryXDR(authEntryXDR);
        setSuccess('Auth entry signed! Copy the auth entry XDR or share URL below and send it to Player 2. Waiting for them to sign...');

        // Start polling for the game to be created by Player 2
        const pollInterval = setInterval(async () => {
          try {
            // Try to load the game
            const game = await zkGameTheoryService.getGame(sessionId);
            if (game) {
              console.log('Game found! Player 2 has finalized the transaction. Transitioning to guess phase...');
              clearInterval(pollInterval);

              // Update game state
              setGameState(game);
              setExportedAuthEntryXDR(null);
              setSuccess('Game created! Player 2 has signed and submitted.');
              setGamePhase('guess');

              // Refresh dashboard to show updated available points (locked in game)
              onStandingsRefresh();

              // Clear success message after 2 seconds
              setTimeout(() => setSuccess(null), 2000);
            } else {
              console.log('Game not found yet, continuing to poll...');
            }
          } catch (err) {
            // Game doesn't exist yet, keep polling
            console.log('Polling for game creation...', err instanceof Error ? err.message : 'checking');
          }
        }, 3000); // Poll every 3 seconds

        // Stop polling after 5 minutes
        setTimeout(() => {
          clearInterval(pollInterval);
          console.log('Stopped polling after 5 minutes');
        }, 300000);
      } catch (err) {
        console.error('Prepare transaction error:', err);
        // Extract detailed error message
        let errorMessage = 'Failed to prepare transaction';
        if (err instanceof Error) {
          errorMessage = err.message;

          // Check for common errors
          if (err.message.includes('insufficient')) {
            errorMessage = `Insufficient points: ${err.message}. Make sure you have enough points for this game.`;
          } else if (err.message.includes('auth')) {
            errorMessage = `Authorization failed: ${err.message}. Check your wallet connection.`;
          }
        }

        setError(errorMessage);

        // Keep the component in 'create' phase so user can see the error and retry
      } finally {
        setLoading(false);
      }
    });
  };

  const handleQuickStart = async () => {
    await runAction(async () => {
      try {
        setQuickstartLoading(true);
        setError(null);
        setSuccess(null);
        if (walletType !== 'dev') {
          throw new Error('Quickstart only works with dev wallets in the Games Library.');
        }

        if (!DevWalletService.isDevModeAvailable() || !DevWalletService.isPlayerAvailable(1) || !DevWalletService.isPlayerAvailable(2)) {
          throw new Error('Quickstart requires both dev wallets. Run "bun run setup" and connect a dev wallet.');
        }

        const p1Points = parsePoints(player1Points);
        if (!p1Points || p1Points <= 0n) {
          throw new Error('Enter a valid points amount');
        }

        const originalPlayer = devWalletService.getCurrentPlayer();
        let player1AddressQuickstart = '';
        let player2AddressQuickstart = '';
        let player1Signer: ReturnType<typeof devWalletService.getSigner> | null = null;
        let player2Signer: ReturnType<typeof devWalletService.getSigner> | null = null;

        try {
          await devWalletService.initPlayer(1);
          player1AddressQuickstart = devWalletService.getPublicKey();
          player1Signer = devWalletService.getSigner();

          await devWalletService.initPlayer(2);
          player2AddressQuickstart = devWalletService.getPublicKey();
          player2Signer = devWalletService.getSigner();
        } finally {
          if (originalPlayer) {
            await devWalletService.initPlayer(originalPlayer);
          }
        }

        if (!player1Signer || !player2Signer) {
          throw new Error('Quickstart failed to initialize dev wallet signers.');
        }

        if (player1AddressQuickstart === player2AddressQuickstart) {
          throw new Error('Quickstart requires two different dev wallets.');
        }

        const quickstartSessionId = createRandomSessionId();
        setSessionId(quickstartSessionId);
        setPlayer1Address(player1AddressQuickstart);
        setCreateMode('create');
        setExportedAuthEntryXDR(null);
        setImportAuthEntryXDR('');
        setImportSessionId('');
        setImportPlayer1('');
        setImportPlayer1Points('');
        setImportPlayer2Points(DEFAULT_POINTS);
        setLoadSessionId('');

        const placeholderPlayer2Address = await getFundedSimulationSourceAddress([
          player1AddressQuickstart,
          player2AddressQuickstart,
        ]);

        const authEntryXDR = await zkGameTheoryService.prepareStartGame(
          quickstartSessionId,
          player1AddressQuickstart,
          placeholderPlayer2Address,
          p1Points,
          p1Points,
          player1Signer
        );

        const fullySignedTxXDR = await zkGameTheoryService.importAndSignAuthEntry(
          authEntryXDR,
          player2AddressQuickstart,
          p1Points,
          player2Signer
        );

        await zkGameTheoryService.finalizeStartGame(
          fullySignedTxXDR,
          player2AddressQuickstart,
          player2Signer
        );

        try {
          const game = await zkGameTheoryService.getGame(quickstartSessionId);
          setGameState(game);
        } catch (err) {
          console.log('Quickstart game not available yet:', err);
        }
        setGamePhase('guess');
        onStandingsRefresh();
        setSuccess('Quickstart complete! Both players signed and the game is ready.');
        setTimeout(() => setSuccess(null), 2000);
      } catch (err) {
        console.error('Quickstart error:', err);
        setError(err instanceof Error ? err.message : 'Quickstart failed');
      } finally {
        setQuickstartLoading(false);
      }
    });
  };

  const handleImportTransaction = async () => {
    await runAction(async () => {
      try {
        setLoading(true);
        setError(null);
        setSuccess(null);
        // Validate required inputs (only auth entry and player 2 points)
        if (!importAuthEntryXDR.trim()) {
          throw new Error('Enter auth entry XDR from Player 1');
        }
        if (!importPlayer2Points.trim()) {
          throw new Error('Enter your points amount (Player 2)');
        }

        // Parse Player 2's points
        const p2Points = parsePoints(importPlayer2Points);
        if (!p2Points || p2Points <= 0n) {
          throw new Error('Invalid Player 2 points');
        }

        // Parse auth entry to extract game parameters
        // The auth entry contains: session_id, player1, player1_points
        console.log('Parsing auth entry to extract game parameters...');
        const gameParams = zkGameTheoryService.parseAuthEntry(importAuthEntryXDR.trim());

        console.log('Extracted from auth entry:', {
          sessionId: gameParams.sessionId,
          player1: gameParams.player1,
          player1Points: gameParams.player1Points.toString(),
        });

        // Auto-populate read-only fields from parsed auth entry (for display)
        setImportSessionId(gameParams.sessionId.toString());
        setImportPlayer1(gameParams.player1);
        setImportPlayer1Points((Number(gameParams.player1Points) / 10_000_000).toString());

        // Verify the user is Player 2 (prevent self-play)
        if (gameParams.player1 === userAddress) {
          throw new Error('Invalid game: You cannot play against yourself (you are Player 1 in this auth entry)');
        }

        // Additional validation: Ensure Player 2 address is different from Player 1
        // (In case user manually edits the Player 2 field)
        if (userAddress === gameParams.player1) {
          throw new Error('Cannot play against yourself. Player 2 must be different from Player 1.');
        }

        const signer = getContractSigner();

        // Step 1: Import Player 1's signed auth entry and rebuild transaction
        // New simplified API - only needs: auth entry, player 2 address, player 2 points
        console.log('Importing Player 1 auth entry and rebuilding transaction...');
        const fullySignedTxXDR = await zkGameTheoryService.importAndSignAuthEntry(
          importAuthEntryXDR.trim(),
          userAddress, // Player 2 address (current user)
          p2Points,
          signer
        );

        // Step 2: Player 2 finalizes and submits (they are the transaction source)
        console.log('Simulating and submitting transaction...');
        await zkGameTheoryService.finalizeStartGame(
          fullySignedTxXDR,
          userAddress,
          signer
        );

        // If we get here, transaction succeeded! Now update state.
        console.log('Transaction submitted successfully! Updating state...');
        setSessionId(gameParams.sessionId);
        setSuccess('Game created successfully! Both players signed.');
        setGamePhase('guess');

        // Clear import fields
        setImportAuthEntryXDR('');
        setImportSessionId('');
        setImportPlayer1('');
        setImportPlayer1Points('');
        setImportPlayer2Points(DEFAULT_POINTS);

        // Load the newly created game state
        await loadGameState();

        // Refresh dashboard to show updated available points (locked in game)
        onStandingsRefresh();

        // Clear success message after 2 seconds
        setTimeout(() => setSuccess(null), 2000);
      } catch (err) {
        console.error('Import transaction error:', err);
        // Extract detailed error message if available
        let errorMessage = 'Failed to import and sign transaction';
        if (err instanceof Error) {
          errorMessage = err.message;

          // Check for common Soroban errors
          if (err.message.includes('simulation failed')) {
            errorMessage = `Simulation failed: ${err.message}. Check that you have enough Points and the game parameters are correct.`;
          } else if (err.message.includes('transaction failed')) {
            errorMessage = `Transaction failed: ${err.message}. The game could not be created on the blockchain.`;
          }
        }

        setError(errorMessage);

        // Keep the component in 'create' phase so user can see the error and retry
        // Don't change gamePhase or clear any fields - let the user see what went wrong
      } finally {
        setLoading(false);
      }
    });
  };

  const handleLoadExistingGame = async () => {
    await runAction(async () => {
      try {
        setLoading(true);
        setError(null);
        setSuccess(null);
        const parsedSessionId = parseInt(loadSessionId.trim());
        if (isNaN(parsedSessionId) || parsedSessionId <= 0) {
          throw new Error('Enter a valid session ID');
        }

        // Try to load the game (use cache to prevent duplicate calls)
        const game = await requestCache.dedupe(
          createCacheKey('game-state', parsedSessionId),
          () => zkGameTheoryService.getGame(parsedSessionId),
          5000
        );

        // Verify game exists and user is one of the players
        if (!game) {
          throw new Error('Game not found');
        }

        if (game.player1 !== userAddress && game.player2 !== userAddress) {
          throw new Error('You are not a player in this game');
        }

        // Load successful - update session ID and transition to game
        setSessionId(parsedSessionId);
        setGameState(game);
        setLoadSessionId('');

        // Determine game phase based on game state
        if (game.is_complete) {
          // Game is complete
          setGamePhase('complete');
          setSuccess('Game complete.');
        } else {
          const getMapValue = (mapVal: any, key: number) => {
            if (!mapVal) return undefined;
            if (mapVal instanceof Map) return mapVal.get(key);
            if (Array.isArray(mapVal)) {
              const entry = mapVal.find((e: any) => e[0] === key || e.key === key);
              if (!entry) return undefined;
              return typeof entry[1] !== 'undefined' ? entry[1] : entry.value;
            }
            return undefined;
          };

          const p1Comm = getMapValue(game.p1_commitments, game.current_round);
          const p2Comm = getMapValue(game.p2_commitments, game.current_round);

          if (p1Comm && p2Comm) {
            setGamePhase('reveal');
            setSuccess('Game loaded! Both players have guessed. You can reveal the winner.');
          } else {
            setGamePhase('guess');
            setSuccess('Game loaded! Make your guess.');
          }
        }

        // Clear success message after 2 seconds
        setTimeout(() => setSuccess(null), 2000);
      } catch (err) {
        console.error('Load game error:', err);
        setError(err instanceof Error ? err.message : 'Failed to load game');
      } finally {
        setLoading(false);
      }
    });
  };

  const copyAuthEntryToClipboard = async () => {
    if (exportedAuthEntryXDR) {
      try {
        await navigator.clipboard.writeText(exportedAuthEntryXDR);
        setAuthEntryCopied(true);
        setTimeout(() => setAuthEntryCopied(false), 2000);
      } catch (err) {
        console.error('Failed to copy auth entry XDR:', err);
        setError('Failed to copy to clipboard');
      }
    }
  };

  const copyShareGameUrlWithAuthEntry = async () => {
    if (exportedAuthEntryXDR) {
      try {
        // Build URL with only Player 1's info and auth entry
        // Player 2 will specify their own points when they import
        const params = new URLSearchParams({
          'game': 'zk-game-theory',
          'auth': exportedAuthEntryXDR,
        });

        const shareUrl = `${window.location.origin}${window.location.pathname}?${params.toString()}`;
        await navigator.clipboard.writeText(shareUrl);
        setShareUrlCopied(true);
        setTimeout(() => setShareUrlCopied(false), 2000);
      } catch (err) {
        console.error('Failed to copy share URL:', err);
        setError('Failed to copy to clipboard');
      }
    }
  };

  const copyShareGameUrlWithSessionId = async () => {
    if (loadSessionId) {
      try {
        const shareUrl = `${window.location.origin}${window.location.pathname}?game=zk-game-theory&session-id=${loadSessionId}`;
        await navigator.clipboard.writeText(shareUrl);
        setShareUrlCopied(true);
        setTimeout(() => setShareUrlCopied(false), 2000);
      } catch (err) {
        console.error('Failed to copy share URL:', err);
        setError('Failed to copy to clipboard');
      }
    }
  };

  const handleCommitMove = async () => {
    if (guess === null) {
      setError('Select a move (Cooperate or Defect)');
      return;
    }

    await runAction(async () => {
      try {
        setLoading(true);
        setError(null);
        setSuccess(null);

        // Generate a random salt for the commit (16 bytes to stay within BN254 field modulus)
        const newSalt = '0x' + Array.from(crypto.getRandomValues(new Uint8Array(16)))
          .map((b) => b.toString(16).padStart(2, '0'))
          .join('');
        setSalt(newSalt);

        if (userAddress) {
          localStorage.setItem(`zk_salt_${sessionId}_${userAddress}`, newSalt);
          localStorage.setItem(`zk_guess_${sessionId}_${userAddress}`, guess.toString());
        }

        const signer = getContractSigner();
        const commitResult = await zkGameTheoryService.commitMove(sessionId, userAddress, guess, newSalt, signer);
        console.log(`[Game.tsx] Player ${userAddress} committed. Salt: ${newSalt}, Commitment: ${commitResult.commitment}`);

        setSuccess(`Move committed!`);
        await loadGameState();
      } catch (err) {
        console.error('Commit move error:', err);
        setError(err instanceof Error ? err.message : 'Failed to commit move');
      } finally {
        setLoading(false);
      }
    });
  };

  const handleRevealMove = async () => {
    if (guess === null || !salt) {
      setError('Missing move or salt for reveal');
      return;
    }

    await runAction(async () => {
      try {
        setLoading(true);
        setError(null);
        setSuccess(null);

        const signer = getContractSigner();
        await zkGameTheoryService.revealMove(sessionId, userAddress, guess, salt, signer);

        setSuccess(`Move revealed!`);
        await loadGameState();
      } catch (err) {
        console.error('Reveal move error:', err);
        setError(err instanceof Error ? err.message : 'Failed to reveal move');
      } finally {
        setLoading(false);
      }
    });
  };

  const waitForWinner = async () => {
    let updatedGame = await zkGameTheoryService.getGame(sessionId);
    let attempts = 0;
    while (attempts < 5 && (!updatedGame || !updatedGame.is_complete)) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      updatedGame = await zkGameTheoryService.getGame(sessionId);
      attempts += 1;
    }
    return updatedGame;
  };

  const handleRevealWinner = async () => {
    await runAction(async () => {
      try {
        setLoading(true);
        setError(null);
        setSuccess(null);

        const signer = getContractSigner();
        // We'll use getGame polling to detect the winner automatically
        // as the contract finalizes it when both have revealed.
        // await zkGameTheoryService.revealWinner(sessionId, userAddress, signer); 

        // Fetch updated on-chain state and derive the winner from it (avoid type mismatches from tx result decoding).
        const updatedGame = await waitForWinner();
        setGameState(updatedGame as any);
        if (updatedGame?.is_complete) {
          setGamePhase('complete');
        } else {
          setGamePhase('guess');
          setGuess(null);
        }

        setSuccess('Move revealed! Wait for opponent or proceed to next round.');

        // Refresh standings immediately (without navigating away)
        onStandingsRefresh();

        // DON'T call onGameComplete() immediately - let user see the results
        // User can click "Start New Game" when ready
      } catch (err) {
        console.error('Reveal winner error:', err);
        setError(err instanceof Error ? err.message : 'Failed to reveal winner');
      } finally {
        setLoading(false);
      }
    });
  };

  const isPlayer1 = gameState && gameState.player1 === userAddress;
  const isPlayer2 = gameState && gameState.player2 === userAddress;

  const getMapValue = (mapVal: any, key: number) => {
    if (!mapVal) return undefined;
    if (mapVal instanceof Map) return mapVal.get(key);
    if (Array.isArray(mapVal)) {
      const entry = mapVal.find((e: any) => e[0] === key || e.key === key);
      if (!entry) return undefined;
      return typeof entry[1] !== 'undefined' ? entry[1] : entry.value;
    }
    return undefined;
  };

  const currentRound = gameState ? (gameState as any).current_round : 1;
  const hasGuessed = isPlayer1 ? getMapValue((gameState as any)?.p1_commitments, currentRound) !== undefined :
    isPlayer2 ? getMapValue((gameState as any)?.p2_commitments, currentRound) !== undefined : false;

  const displayP1Points = (gameState as any)?.p1_score; // Now track score
  const displayP2Points = (gameState as any)?.p2_score;

  const gameHistory = [];
  if (gameState) {
    for (let r = 1; r <= 5; r++) {
      const p1Move = getMapValue((gameState as any).p1_moves, r);
      const p2Move = getMapValue((gameState as any).p2_moves, r);
      let p1Points = 0;
      let p2Points = 0;
      if (p1Move !== undefined && p2Move !== undefined) {
        if (p1Move === 0 && p2Move === 0) { p1Points = 3; p2Points = 3; }
        else if (p1Move === 1 && p2Move === 1) { p1Points = 1; p2Points = 1; }
        else if (p1Move === 0 && p2Move === 1) { p1Points = 0; p2Points = 5; }
        else if (p1Move === 1 && p2Move === 0) { p1Points = 5; p2Points = 0; }
      }
      gameHistory.push({
        round: r,
        p1Move,
        p2Move,
        p1Points,
        p2Points,
        isCurrent: r === currentRound,
        isPast: r < currentRound || ((gameState as any).is_complete && r === 5)
      });
    }
  }

  return (
    <div className="bg-white/70 backdrop-blur-xl rounded-xl p-3.5 sm:p-5 shadow-lg border border-purple-200 w-full overflow-hidden">
      <div className="flex items-center justify-between mb-3">
        <div className="leading-tight">
          <h2 className="text-lg font-black bg-gradient-to-r from-purple-600 via-pink-600 to-red-600 bg-clip-text text-transparent">
            The Tie-Breaker
          </h2>
          <p className="text-xs leading-relaxed font-semibold text-gray-700 mt-2">
            The leaderboard is locked. You and a rival developer are tied for 1st Place in the Stellar ZK Hackathon.
            To decide the winning share for each winner, the judges have initiated a high-stakes, 5-round Tie-Breaker.
          </p>
          <p className="text-xs text-gray-500 font-mono mt-3">
            Session ID: {sessionId}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* RULES TOOLTIP */}
          {gameState && (
            <div className="relative group">
              <button className="w-8 h-8 flex items-center justify-center rounded-full bg-blue-50 text-blue-600 hover:bg-blue-100 transition-all border border-blue-200">
                <span className="text-sm font-bold">ⓘ</span>
              </button>

              {/* Tooltip Card */}
              <div className="absolute right-0 top-10 w-72 sm:w-80 bg-white/95 backdrop-blur-xl border border-blue-200 rounded-2xl shadow-2xl p-4 z-50 invisible group-hover:visible opacity-0 group-hover:opacity-100 transition-all transform scale-95 group-hover:scale-100 origin-top-right">
                <h3 className="text-[11px] font-black uppercase tracking-widest text-blue-800 mb-3 flex items-center gap-1.5">
                  <span>📜</span> Game Details
                </h3>

                <div className="space-y-4">
                  <div>
                    <p className="text-[11px] font-black text-blue-900 uppercase tracking-tight mb-1">The Rules</p>
                    <p className="text-[11px] text-gray-700 leading-normal">
                      Final split is determined by Total Points over 5 rounds.
                      Moves are ZK-encrypted—hidden from rivals until revealed.
                    </p>
                  </div>

                  <div>
                    <p className="text-[11px] font-black text-blue-900 uppercase tracking-tight mb-1.5">Scoring (Per Round)</p>
                    <div className="grid grid-cols-1 gap-1.5">
                      <div className="flex items-start gap-2 bg-blue-50/50 p-2 rounded-lg border border-blue-50">
                        <span className="text-base">🤝</span>
                        <p className="text-[11px] text-gray-700 font-medium"><span className="font-bold text-blue-800 italic">Both Pact:</span> Both cooperate. +3 pts each.</p>
                      </div>
                      <div className="flex items-start gap-2 bg-blue-50/50 p-2 rounded-lg border border-blue-50">
                        <span className="text-base">⚔️</span>
                        <p className="text-[11px] text-gray-700 font-medium"><span className="font-bold text-pink-700 italic">You Double Cross:</span> You betray. +5 pts for you, 0 for them.</p>
                      </div>
                      <div className="flex items-start gap-2 bg-blue-50/50 p-2 rounded-lg border border-blue-50">
                        <span className="text-base">💀</span>
                        <p className="text-[11px] text-gray-700 font-medium"><span className="font-bold text-red-700 italic">Both Double Cross:</span> Both betray. +1 pt each.</p>
                      </div>
                    </div>
                  </div>

                  <div>
                    <p className="text-[11px] font-black text-blue-900 uppercase tracking-tight mb-1">The Final Payout</p>
                    <div className="space-y-1.5 mt-1">
                      <p className="text-[11px] text-gray-700 leading-snug"><span className="font-bold text-gray-900">Co-Champions:</span> Full cooperation = equal share of XLM each.</p>
                      <p className="text-[11px] text-gray-700 leading-snug"><span className="font-bold text-gray-900">Solo Winner:</span> Highest score takes the majority.</p>
                      <p className="text-[11px] text-gray-700 leading-snug"><span className="font-bold text-gray-900">Mutual Failure:</span> Both betray results in a heavy loss for both.</p>
                    </div>
                  </div>

                  <p className="text-[11px] font-black text-center text-blue-800 italic pt-1 border-t border-blue-50 mt-2">
                    "Trust is a variable. Privacy is a proof."
                  </p>
                </div>
              </div>
            </div>
          )}

          {gamePhase !== 'create' && (
            <button
              onClick={handleStartNewGame}
              className="px-4 py-2 rounded-xl border border-gray-200 text-xs font-bold text-gray-500 hover:bg-gray-50 hover:text-red-500 transition-all flex items-center gap-2 shadow-sm"
            >
              <span>🚪</span> Exit Game
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="mb-3 p-2 bg-red-50 border border-red-200 rounded-xl">
          <p className="text-xs font-bold text-red-700 text-center">{error}</p>
        </div>
      )}

      {success && (
        <div className="mb-3 p-2 bg-green-50 border border-green-200 rounded-xl">
          <p className="text-xs font-bold text-green-700 text-center">{success}</p>
        </div>
      )}

      {/* GAME HISTORY TABLE REMOVED FROM HERE, MOVED TO BOTTOM */}

      {/* CREATE GAME PHASE */}
      {gamePhase === 'create' && (
        <div className="space-y-3">
          {/* Mode Toggle */}
          <div className="flex flex-col sm:flex-row items-center justify-center gap-3 p-2 bg-gray-100 rounded-xl">
            <button
              onClick={() => {
                setCreateMode('create');
                setExportedAuthEntryXDR(null);
                setImportAuthEntryXDR('');
                setImportSessionId('');
                setImportPlayer1('');
                setImportPlayer1Points('');
                setImportPlayer2Points(DEFAULT_POINTS);
                setLoadSessionId('');
              }}
              className={`flex-1 py-3 px-4 rounded-xl font-bold text-xs transition-all ${createMode === 'create'
                ? 'bg-gradient-to-r from-purple-500 to-pink-500 text-white shadow-md'
                : 'bg-white text-gray-600 hover:bg-gray-50'
                }`}
            >
              Create & Export Game
            </button>
            <button
              onClick={() => {
                setCreateMode('import');
                setExportedAuthEntryXDR(null);
                setLoadSessionId('');
              }}
              className={`flex-1 py-3 px-4 rounded-xl font-bold text-xs transition-all ${createMode === 'import'
                ? 'bg-gradient-to-r from-blue-500 to-cyan-500 text-white shadow-md'
                : 'bg-white text-gray-600 hover:bg-gray-50'
                }`}
            >
              Import Auth
            </button>
            <button
              onClick={() => {
                setCreateMode('load');
                setExportedAuthEntryXDR(null);
                setImportAuthEntryXDR('');
                setImportSessionId('');
                setImportPlayer1('');
                setImportPlayer1Points('');
                setImportPlayer2Points(DEFAULT_POINTS);
              }}
              className={`flex-1 py-3 px-4 rounded-xl font-bold text-xs transition-all ${createMode === 'load'
                ? 'bg-gradient-to-r from-green-500 to-emerald-500 text-white shadow-md'
                : 'bg-white text-gray-600 hover:bg-gray-50'
                }`}
            >
              Load Game
            </button>
          </div>

          <div className="p-3 bg-gradient-to-r from-yellow-50 to-orange-50 border border-yellow-200 rounded-xl shadow-sm">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-xs font-bold text-yellow-900 leading-tight">⚡ Quickstart</p>
                <p className="text-[10px] text-yellow-800 opacity-90 leading-tight mt-1">
                  Auto-sign and start the game in one click. Works only in the Games Library.
                </p>
              </div>
              <button
                onClick={handleQuickStart}
                disabled={isBusy || !quickstartAvailable}
                className="px-4 py-2 rounded-xl font-bold text-xs text-white bg-gradient-to-r from-yellow-500 to-orange-500 hover:from-yellow-600 hover:to-orange-600 disabled:from-gray-200 disabled:to-gray-300 transition-all shadow-md transform hover:scale-105"
              >
                {quickstartLoading ? '...' : 'Quickstart'}
              </button>
            </div>
          </div>

          {createMode === 'create' ? (
            <div className="space-y-3">
              <div className="space-y-2">
                <div>
                  <label className="block text-xs font-bold text-gray-600 mb-1">
                    Your Address
                  </label>
                  <input
                    type="text"
                    value={player1Address}
                    onChange={(e) => setPlayer1Address(e.target.value.trim())}
                    placeholder="G..."
                    className="w-full px-3 py-2 rounded-lg bg-white border border-gray-200 focus:border-purple-400 text-xs font-mono"
                  />
                </div>

                <div className="mb-2">
                  <label className="block text-xs font-bold text-gray-600 mb-1">
                    Entry Fee
                  </label>
                  <input
                    type="text"
                    value="10 XLM"
                    readOnly
                    className="w-24 px-3 py-2 rounded-lg bg-gray-50 border border-gray-200 text-xs font-bold text-gray-500 cursor-not-allowed"
                  />
                </div>

                <div className="p-3 bg-blue-50 border-2 border-blue-200 rounded-xl">
                  <p className="text-xs font-semibold text-blue-800">
                    ℹ️ Player 2 will specify their own address and points when they import your auth entry. You only need to prepare and export your signature.
                  </p>
                </div>
              </div>

              <div className="pt-4 border-t-2 border-gray-100 space-y-4">
                <p className="text-sm font-bold text-gray-700">
                  Session ID: {sessionId}
                </p>

                {!exportedAuthEntryXDR ? (
                  <button
                    onClick={handlePrepareTransaction}
                    disabled={isBusy}
                    className="w-full py-4 rounded-xl font-bold text-white text-sm bg-gradient-to-r from-purple-500 to-pink-500 hover:from-purple-600 hover:to-pink-600 disabled:from-gray-200 disabled:to-gray-300 disabled:text-gray-500 transition-all shadow-lg hover:shadow-xl transform hover:scale-105 disabled:transform-none"
                  >
                    {loading ? 'Preparing...' : 'Prepare & Export Auth Entry'}
                  </button>
                ) : (
                  <div className="space-y-3">
                    <div className="p-4 bg-gradient-to-br from-green-50 to-emerald-50 border-2 border-green-200 rounded-xl">
                      <p className="text-sm font-black uppercase tracking-wider text-green-700 mb-2">
                        Auth Entry XDR (Player 1 Signed)
                      </p>
                      <div className="bg-white p-3 rounded-lg border border-green-200 mb-3">
                        <code className="text-xs font-mono text-gray-700 break-all">
                          {exportedAuthEntryXDR}
                        </code>
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <button
                          onClick={copyAuthEntryToClipboard}
                          className="py-3 rounded-lg bg-gradient-to-r from-green-500 to-emerald-500 hover:from-green-600 hover:to-emerald-600 text-white font-bold text-sm transition-all shadow-md hover:shadow-lg transform hover:scale-105"
                        >
                          {authEntryCopied ? '✓ Copied!' : '📋 Copy Auth Entry'}
                        </button>
                        <button
                          onClick={copyShareGameUrlWithAuthEntry}
                          className="py-3 rounded-lg bg-gradient-to-r from-blue-500 to-indigo-500 hover:from-blue-600 hover:to-indigo-600 text-white font-bold text-sm transition-all shadow-md hover:shadow-lg transform hover:scale-105"
                        >
                          {shareUrlCopied ? '✓ Copied!' : '🔗 Share URL'}
                        </button>
                      </div>
                    </div>
                    <p className="text-sm text-gray-700 text-center font-bold">
                      Copy the auth entry XDR or share URL with Player 2 to complete the transaction
                    </p>
                  </div>
                )}
              </div>
            </div>
          ) : createMode === 'import' ? (
            /* IMPORT MODE */
            <div className="space-y-4">
              <div className="p-4 bg-gradient-to-br from-blue-50 to-cyan-50 border-2 border-blue-200 rounded-xl">
                <p className="text-sm font-semibold text-blue-800 mb-2">
                  📥 Import Auth Entry from Player 1
                </p>
                <p className="text-sm text-gray-800 mb-4 font-medium">
                  Paste the auth entry XDR from Player 1. Session ID, Player 1 address, and their points will be auto-extracted. You only need to enter your points amount.
                </p>
                <div className="space-y-3">
                  <div>
                    <label className="block text-xs font-bold text-gray-700 mb-1 flex items-center gap-2">
                      Auth Entry XDR
                      {xdrParsing && (
                        <span className="text-blue-500 text-xs animate-pulse">Parsing...</span>
                      )}
                      {xdrParseSuccess && (
                        <span className="text-green-600 text-xs">✓ Parsed successfully</span>
                      )}
                      {xdrParseError && (
                        <span className="text-red-600 text-xs">✗ Parse failed</span>
                      )}
                    </label>
                    <textarea
                      value={importAuthEntryXDR}
                      onChange={(e) => setImportAuthEntryXDR(e.target.value)}
                      placeholder="Paste Player 1's signed auth entry XDR here..."
                      rows={4}
                      className={`w-full px-4 py-3 rounded-xl bg-white border-2 focus:outline-none focus:ring-4 text-xs font-mono resize-none transition-colors ${xdrParseError
                        ? 'border-red-300 focus:border-red-400 focus:ring-red-100'
                        : xdrParseSuccess
                          ? 'border-green-300 focus:border-green-400 focus:ring-green-100'
                          : 'border-blue-200 focus:border-blue-400 focus:ring-blue-100'
                        }`}
                    />
                    {xdrParseError && (
                      <p className="text-xs text-red-600 font-semibold mt-1">
                        {xdrParseError}
                      </p>
                    )}
                  </div>
                  {/* Auto-populated fields from auth entry (read-only) */}
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-bold text-gray-500 mb-1">Session ID (auto-filled)</label>
                      <input
                        type="text"
                        value={importSessionId}
                        readOnly
                        placeholder="Auto-filled from auth entry"
                        className="w-full px-4 py-2 rounded-xl bg-gray-50 border-2 border-gray-200 text-xs font-mono text-gray-600 cursor-not-allowed"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-bold text-gray-500 mb-1">Player 1 Points (auto-filled)</label>
                      <input
                        type="text"
                        value={importPlayer1Points}
                        readOnly
                        placeholder="Auto-filled from auth entry"
                        className="w-full px-4 py-2 rounded-xl bg-gray-50 border-2 border-gray-200 text-xs text-gray-600 cursor-not-allowed"
                      />
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs font-bold text-gray-500 mb-1">Player 1 Address (auto-filled)</label>
                    <input
                      type="text"
                      value={importPlayer1}
                      readOnly
                      placeholder="Auto-filled from auth entry"
                      className="w-full px-4 py-2 rounded-xl bg-gray-50 border-2 border-gray-200 text-xs font-mono text-gray-600 cursor-not-allowed"
                    />
                  </div>
                  {/* User inputs */}
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-bold text-gray-500 mb-1">Player 2 (You)</label>
                      <input
                        type="text"
                        value={userAddress}
                        readOnly
                        className="w-full px-4 py-2 rounded-xl bg-gray-50 border-2 border-gray-200 text-xs font-mono text-gray-600 cursor-not-allowed"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-bold text-gray-700 mb-1">Entry Fee</label>
                      <input
                        type="text"
                        value="10 XLM"
                        readOnly
                        className="w-24 px-4 py-2 rounded-xl bg-gray-50 border-2 border-gray-200 text-xs font-medium text-gray-600 cursor-not-allowed"
                      />
                    </div>
                  </div>
                </div>
              </div>

              <button
                onClick={handleImportTransaction}
                disabled={isBusy || !importAuthEntryXDR.trim() || !importPlayer2Points.trim()}
                className="w-full py-4 rounded-xl font-bold text-white text-lg bg-gradient-to-r from-blue-500 via-cyan-500 to-teal-500 hover:from-blue-600 hover:via-cyan-600 hover:to-teal-600 disabled:from-gray-200 disabled:to-gray-300 disabled:text-gray-500 transition-all shadow-xl hover:shadow-2xl transform hover:scale-105 disabled:transform-none"
              >
                {loading ? 'Importing & Signing...' : 'Import & Sign Auth Entry'}
              </button>
            </div>
          ) : createMode === 'load' ? (
            /* LOAD EXISTING GAME MODE */
            <div className="space-y-4">
              <div className="p-4 bg-gradient-to-br from-green-50 to-emerald-50 border-2 border-green-200 rounded-xl">
                <p className="text-sm font-semibold text-green-800 mb-2">
                  🎮 Load Existing Game by Session ID
                </p>
                <p className="text-sm text-gray-800 mb-4 font-medium">
                  Enter a session ID to load and continue an existing game. You must be one of the players.
                </p>
                <input
                  type="text"
                  value={loadSessionId}
                  onChange={(e) => setLoadSessionId(e.target.value)}
                  placeholder="Enter session ID (e.g., 123456789)"
                  className="w-full px-4 py-3 rounded-xl bg-white border-2 border-green-200 focus:outline-none focus:border-green-400 focus:ring-4 focus:ring-green-100 text-sm font-mono"
                />
              </div>

              <div className="p-4 bg-gradient-to-br from-yellow-50 to-amber-50 border-2 border-yellow-200 rounded-xl">
                <p className="text-xs font-bold text-yellow-800 mb-2">
                  Requirements
                </p>
                <ul className="text-xs text-gray-700 space-y-1 list-disc list-inside">
                  <li>You must be Player 1 or Player 2 in the game</li>
                  <li>Game must be active (not completed)</li>
                  <li>Valid session ID from an existing game</li>
                </ul>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <button
                  onClick={handleLoadExistingGame}
                  disabled={isBusy || !loadSessionId.trim()}
                  className="py-4 rounded-xl font-bold text-white text-lg bg-gradient-to-r from-green-500 via-emerald-500 to-teal-500 hover:from-green-600 hover:via-emerald-600 hover:to-teal-600 disabled:from-gray-200 disabled:to-gray-300 disabled:text-gray-500 transition-all shadow-xl hover:shadow-2xl transform hover:scale-105 disabled:transform-none"
                >
                  {loading ? 'Loading...' : '🎮 Load Game'}
                </button>
                <button
                  onClick={copyShareGameUrlWithSessionId}
                  disabled={!loadSessionId.trim()}
                  className="py-4 rounded-xl font-bold text-white text-lg bg-gradient-to-r from-blue-500 to-indigo-500 hover:from-blue-600 hover:to-indigo-600 disabled:from-gray-200 disabled:to-gray-300 disabled:text-gray-500 transition-all shadow-xl hover:shadow-2xl transform hover:scale-105 disabled:transform-none"
                >
                  {shareUrlCopied ? '✓ Copied!' : '🔗 Share Game'}
                </button>
              </div>
              <p className="text-xs text-gray-600 text-center font-semibold">
                Load the game to continue playing, or share the URL with another player
              </p>
            </div>
          ) : null}
        </div>
      )}

      {/* GUESS PHASE */}
      {gamePhase === 'guess' && gameState && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <div className={`p-4 rounded-xl border-2 ${isPlayer1 ? 'border-purple-500 bg-gradient-to-br from-purple-50 to-pink-50 shadow-sm' : 'border-gray-200 bg-white'}`}>
              <div className="text-xs font-black uppercase tracking-wider text-gray-500 mb-1">Player 1</div>
              <div className="font-mono text-sm font-bold mb-1.5 text-gray-900 bg-white/50 px-2 py-0.5 rounded border border-gray-100 truncate">
                {gameState.player1.slice(0, 6)}...{gameState.player1.slice(-4)}
              </div>
              <div className="text-sm font-black text-gray-800">
                Score: {displayP1Points} pts
              </div>
              <div className="mt-2">
                {getMapValue((gameState as any)?.p1_commitments, currentRound) ? (
                  <div className="inline-block px-2 py-0.5 rounded bg-green-100 text-green-700 text-xs font-black">✓ READY</div>
                ) : (
                  <div className="inline-block px-2 py-0.5 rounded bg-amber-100 text-amber-700 text-xs font-black">WAITING</div>
                )}
              </div>
            </div>

            <div className={`p-4 rounded-xl border-2 ${isPlayer2 ? 'border-purple-500 bg-gradient-to-br from-purple-50 to-pink-50 shadow-sm' : 'border-gray-200 bg-white'}`}>
              <div className="text-xs font-black uppercase tracking-wider text-gray-500 mb-1">Player 2</div>
              <div className="font-mono text-sm font-bold mb-1.5 text-gray-900 bg-white/50 px-2 py-0.5 rounded border border-gray-100 truncate">
                {gameState.player2.slice(0, 6)}...{gameState.player2.slice(-4)}
              </div>
              <div className="text-sm font-black text-gray-800">
                Score: {displayP2Points} pts
              </div>
              <div className="mt-2">
                {getMapValue((gameState as any)?.p2_commitments, currentRound) ? (
                  <div className="inline-block px-2 py-0.5 rounded bg-green-100 text-green-700 text-xs font-black">✓ READY</div>
                ) : (
                  <div className="inline-block px-2 py-0.5 rounded bg-amber-100 text-amber-700 text-xs font-black">WAITING</div>
                )}
              </div>
            </div>
          </div>

          {(isPlayer1 || isPlayer2) && !hasGuessed && (
            <div className="space-y-2">
              <label className="block text-xs font-bold uppercase tracking-wider text-gray-500">
                Choose Your Move
              </label>
              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={() => setGuess(0)}
                  className={`p-3 rounded-xl border transition-all flex flex-col items-center gap-1 ${guess === 0
                    ? 'border-green-500 bg-gradient-to-br from-green-50 to-emerald-50 shadow-sm'
                    : 'border-gray-200 bg-white hover:border-green-300'
                    }`}
                >
                  <span className="text-xl">🤝</span>
                  <span className="font-black text-xs text-green-700">COOPERATE</span>
                  <span className="text-[10px] text-green-600 font-bold opacity-80 leading-none">Mutual Reward</span>
                </button>
                <button
                  onClick={() => setGuess(1)}
                  className={`p-3 rounded-xl border transition-all flex flex-col items-center gap-1 ${guess === 1
                    ? 'border-red-500 bg-gradient-to-br from-red-50 to-pink-50 shadow-sm'
                    : 'border-gray-200 bg-white hover:border-red-300'
                    }`}
                >
                  <span className="text-xl">🔪</span>
                  <span className="font-black text-xs text-red-700">DEFECT</span>
                  <span className="text-[10px] text-red-600 font-bold opacity-80 leading-none">Betray For More</span>
                </button>
              </div>
              <button
                onClick={handleCommitMove}
                disabled={isBusy || guess === null}
                className="w-full mt-2 py-3 rounded-xl font-bold text-white text-sm bg-gradient-to-r from-purple-500 via-pink-500 to-red-500 hover:from-purple-600 hover:via-pink-600 hover:to-red-600 disabled:from-gray-200 disabled:to-gray-300 disabled:text-gray-500 transition-all shadow-md hover:shadow-lg transform hover:scale-[1.02]"
              >
                {loading ? '� Proof...' : 'Commit Move'}
              </button>
              <p className="text-center text-[9px] text-gray-400 font-medium leading-none">
                ZK-protected hash applied.
              </p>
            </div>
          )}

          {hasGuessed && (
            <div className="p-2.5 bg-gradient-to-r from-blue-50 to-cyan-50 border border-blue-200 rounded-lg">
              <p className="text-[10px] font-bold text-blue-700 text-center">
                ✓ Secured. Awaiting opponent...
              </p>
            </div>
          )}
        </div>
      )}

      {/* REVEAL PHASE */}
      {gamePhase === 'reveal' && gameState && (
        <div className="space-y-4">
          <div className="p-5 bg-gradient-to-br from-yellow-50 via-orange-50 to-amber-50 border border-yellow-300 rounded-xl text-center shadow-md">
            <div className="text-2xl mb-2">🕵️‍♂️</div>
            <h3 className="text-lg font-black text-gray-900 mb-1">
              Ready to Reveal!
            </h3>
            <p className="text-xs font-semibold text-gray-600 mb-3">
              Generate ZK proof to finish.
            </p>
            <button
              onClick={handleRevealMove}
              disabled={isBusy || (isPlayer1 ? getMapValue((gameState as any)?.p1_moves, currentRound) !== undefined : getMapValue((gameState as any)?.p2_moves, currentRound) !== undefined)}
              className="px-6 py-2.5 rounded-xl font-bold text-white text-sm bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-700 hover:to-indigo-700 transition-all shadow-md"
            >
              {loading ? '🔮 Proof...' : (isPlayer1 && getMapValue((gameState as any)?.p1_moves, currentRound) !== undefined) || (isPlayer2 && getMapValue((gameState as any)?.p2_moves, currentRound) !== undefined) ? 'Revealed' : 'Reveal Move with ZK'}
            </button>
            <p className="mt-2 text-[9px] text-gray-500 italic">
              Note: If both players have revealed, the round completes.
            </p>
          </div>
        </div>
      )}

      {/* COMPLETE PHASE */}
      {gamePhase === 'complete' && gameState && (
        <div className="space-y-4">
          <div className="p-5 bg-gradient-to-br from-green-50 via-emerald-50 to-teal-50 border border-green-300 rounded-xl text-center shadow-md">
            <div className="text-3xl mb-2">🏁</div>
            <h3 className="text-xl font-black text-gray-900 mb-2">
              Game Over!
            </h3>

            <div className="p-3 bg-white border border-green-200 rounded-lg">
              <p className="text-xs font-black uppercase tracking-tight text-green-600 mb-1">Result</p>
              <p className="font-black text-lg text-gray-900 leading-tight">
                {Number(displayP1Points) === Number(displayP2Points) ? "🤝 STALEMATE" :
                  (isPlayer1 && Number(displayP1Points) > Number(displayP2Points)) || (isPlayer2 && Number(displayP2Points) > Number(displayP1Points)) ? "💰 VICTORY!" :
                    "💀 DEFEAT!"}
              </p>
            </div>
          </div>
          <button
            onClick={handleStartNewGame}
            className="w-full py-3 rounded-xl font-bold text-gray-700 text-sm bg-gradient-to-r from-gray-200 to-gray-300 hover:from-gray-300 hover:to-gray-400 transition-all shadow-md transform hover:scale-[1.02]"
          >
            Start New Game
          </button>
        </div>
      )}

      {/* GAME HISTORY TABLE */}
      {gameState && (
        <div className="mt-4 border-t border-purple-100 pt-3">
          <h3 className="text-[11px] font-black uppercase tracking-widest text-gray-400 mb-2 flex items-center gap-1.5">
            <span>📊</span> History
          </h3>
          <div className="overflow-x-auto rounded-lg border border-gray-200 shadow-sm">
            <table className="w-full text-xs text-center border-collapse">
              <thead className="bg-gray-50 border-b border-gray-100">
                <tr>
                  <th className="px-3 py-2 font-black text-gray-600 text-xs">Round</th>
                  <th className="px-3 py-2 font-black text-gray-600 text-xs">P1</th>
                  <th className="px-3 py-2 font-black text-gray-600 text-xs">P2</th>
                  <th className="px-3 py-2 font-black text-gray-600 text-xs">Pts</th>
                  <th className="px-3 py-2 font-black text-gray-600 text-xs">Pts</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 bg-white">
                {gameHistory.map((row) => (
                  <tr key={row.round} className={`${row.isCurrent ? 'bg-purple-50' : row.isPast ? '' : 'text-gray-300'}`}>
                    <td className="px-2 py-2 font-black text-sm">
                      {row.round}
                      {row.isCurrent && !(gameState as any).is_complete && <span className="ml-1 text-xs text-purple-600 animate-pulse">★</span>}
                    </td>
                    <td className="px-2 py-1.5 text-base">
                      {row.p1Move === 0 ? '🤝' : row.p1Move === 1 ? '🔪' : (row.isPast || (row.isCurrent && getMapValue((gameState as any)?.p1_commitments, row.round))) ? '❓' : '-'}
                    </td>
                    <td className="px-2 py-1.5 text-base">
                      {row.p2Move === 0 ? '🤝' : row.p2Move === 1 ? '🔪' : (row.isPast || (row.isCurrent && getMapValue((gameState as any)?.p2_commitments, row.round))) ? '❓' : '-'}
                    </td>
                    <td className={`px-2 py-2 font-mono font-black text-sm ${row.p1Points > 0 ? 'text-green-600' : 'text-gray-400'}`}>
                      {row.isPast || (row.p1Move !== undefined && row.p2Move !== undefined) ? `+${row.p1Points}` : '-'}
                    </td>
                    <td className={`px-2 py-2 font-mono font-black text-sm ${row.p2Points > 0 ? 'text-green-600' : 'text-gray-400'}`}>
                      {row.isPast || (row.p1Move !== undefined && row.p2Move !== undefined) ? `+${row.p2Points}` : '-'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-3 flex justify-between px-4 py-3 bg-gradient-to-r from-purple-50 via-pink-50 to-red-50 rounded-lg border border-purple-100 font-black text-gray-800 text-xs">
            <div>P1 Total: {displayP1Points} <span className="text-xs text-gray-500 font-medium">({(Number(displayP1Points || 0) * 0.3).toFixed(1)} XLM)</span></div>
            <div>P2 Total: {displayP2Points} <span className="text-xs text-gray-500 font-medium">({(Number(displayP2Points || 0) * 0.3).toFixed(1)} XLM)</span></div>
          </div>
        </div>
      )}
    </div>
  );
}
