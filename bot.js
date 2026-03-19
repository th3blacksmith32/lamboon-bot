const {
  Connection,
  PublicKey,
  Keypair,
  LAMPORTS_PER_SOL,
  SystemProgram,
  Transaction
} = require("@solana/web3.js");
const { getOrCreateAssociatedTokenAccount, transfer } = require("@solana/spl-token");
const { createClient } = require("@supabase/supabase-js");
const bs58Module = require("bs58");
require("dotenv").config();

const bs58 = bs58Module.decode ? bs58Module : bs58Module.default;

const TREASURY_WALLET = new PublicKey(process.env.TREASURY_ADDRESS);
const FEE_WALLET = new PublicKey(process.env.FEE_WALLET);
const MINT_ADDRESS = new PublicKey(process.env.TOKEN_MINT_ADDRESS);
const TOKEN_DECIMALS = Number(process.env.TOKEN_DECIMALS || "6");
const MINT_AMOUNT = Number(process.env.MINT_AMOUNT || "10000");
const RPC_URL = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
const REQUIRED_PAYMENT_SOL = Number(process.env.REQUIRED_PAYMENT_SOL || "0.035");
const FEE_AMOUNT_SOL = Number(process.env.FEE_AMOUNT_SOL || "0.010");
const MAX_MINTS_PER_WALLET = Number(process.env.MAX_MINTS_PER_WALLET || "10");
const REQUIRED_PAYMENT_LAMPORTS = Math.round(REQUIRED_PAYMENT_SOL * LAMPORTS_PER_SOL);
const FEE_AMOUNT_LAMPORTS = Math.round(FEE_AMOUNT_SOL * LAMPORTS_PER_SOL);

const connection = new Connection(RPC_URL, "confirmed");

function loadSecretKey(value) {
  const secret = value?.trim();

  if (!secret) {
    throw new Error("Missing PRIVATE_KEY in .env");
  }

  if (secret.startsWith("[")) {
    return Uint8Array.from(JSON.parse(secret));
  }

  return Uint8Array.from(bs58.decode(secret));
}

const botKeypair = Keypair.fromSecretKey(loadSecretKey(process.env.PRIVATE_KEY));
const processedSignatures = new Set();
const supabase = createAdminClient();

console.log("$LAMBOON Bot started. Watching Treasury:", TREASURY_WALLET.toBase58());
console.log("Fee wallet:", FEE_WALLET.toBase58());
console.log("Required payment:", REQUIRED_PAYMENT_SOL, "SOL");
console.log("Forwarded fee:", FEE_AMOUNT_SOL, "SOL");
console.log("Max mints per wallet:", MAX_MINTS_PER_WALLET);

function createAdminClient() {
  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env");
  }

  return createClient(url, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  });
}

async function runBot() {
  connection.onLogs(
    TREASURY_WALLET,
    async (logs) => {
      const signature = logs.signature;

      if (!signature || processedSignatures.has(signature)) {
        return;
      }

      processedSignatures.add(signature);

      try {
        const tx = await connection.getParsedTransaction(signature, {
          maxSupportedTransactionVersion: 0
        });

        if (!tx) {
          return;
        }

        const paymentInstruction = tx.transaction.message.instructions.find(
          (ix) =>
            "parsed" in ix &&
            ix.parsed?.type === "transfer" &&
            ix.parsed?.info?.destination === TREASURY_WALLET.toBase58() &&
            Number(ix.parsed?.info?.lamports || 0) >= REQUIRED_PAYMENT_LAMPORTS
        );

        if (!paymentInstruction) {
          return;
        }

        const sender = paymentInstruction.parsed?.info?.source;

        if (sender) {
          const currentMintCount = await getWalletMintCount(sender);

          if (currentMintCount >= MAX_MINTS_PER_WALLET) {
            console.log(
              `Mint limit reached for ${sender}. Skipping fulfillment for payment ${signature}.`
            );
            return;
          }

          console.log(
            `Payment detected from ${sender}. Mint ${currentMintCount + 1}/${MAX_MINTS_PER_WALLET}. Sending ${MINT_AMOUNT} $LAMBOON...`
          );
          await sendTokens(new PublicKey(sender));
          await recordWalletMint(sender, currentMintCount + 1);
          await forwardFee(signature);
        }
      } catch (err) {
        console.error("Error processing transaction:", signature, err);
      }
    },
    "confirmed"
  );
}

async function sendTokens(recipient) {
  try {
    const fromAta = await getOrCreateAssociatedTokenAccount(
      connection,
      botKeypair,
      MINT_ADDRESS,
      botKeypair.publicKey
    );
    const toAta = await getOrCreateAssociatedTokenAccount(
      connection,
      botKeypair,
      MINT_ADDRESS,
      recipient
    );

    const tx = await transfer(
      connection,
      botKeypair,
      fromAta.address,
      toAta.address,
      botKeypair.publicKey,
      BigInt(MINT_AMOUNT) * BigInt(10 ** TOKEN_DECIMALS)
    );

    console.log(`Tokens sent. Sig: ${tx}`);
  } catch (e) {
    console.error("Token transfer failed:", e);
  }
}

async function getWalletMintCount(walletAddress) {
  const { data, error } = await supabase
    .from("wallet_mints")
    .select("mint_count")
    .eq("wallet_address", walletAddress)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to load wallet mint count: ${error.message}`);
  }

  return typeof data?.mint_count === "number" ? data.mint_count : 0;
}

async function recordWalletMint(walletAddress, mintCount) {
  const { error } = await supabase.from("wallet_mints").upsert({
    wallet_address: walletAddress,
    mint_count: mintCount
  });

  if (error) {
    throw new Error(`Failed to record wallet mint count: ${error.message}`);
  }
}

async function forwardFee(sourceSignature) {
  try {
    const latestBlockhash = await connection.getLatestBlockhash("confirmed");
    const transaction = new Transaction({
      feePayer: botKeypair.publicKey,
      blockhash: latestBlockhash.blockhash,
      lastValidBlockHeight: latestBlockhash.lastValidBlockHeight
    }).add(
      SystemProgram.transfer({
        fromPubkey: botKeypair.publicKey,
        toPubkey: FEE_WALLET,
        lamports: FEE_AMOUNT_LAMPORTS
      })
    );

    const feeSignature = await connection.sendTransaction(transaction, [botKeypair], {
      skipPreflight: false
    });

    await connection.confirmTransaction(
      {
        signature: feeSignature,
        blockhash: latestBlockhash.blockhash,
        lastValidBlockHeight: latestBlockhash.lastValidBlockHeight
      },
      "confirmed"
    );

    console.log(`Fee forwarded for payment ${sourceSignature}. Fee tx: ${feeSignature}`);
  } catch (error) {
    console.error(`Fee forwarding failed for payment ${sourceSignature}:`, error);
  }
}

runBot();
