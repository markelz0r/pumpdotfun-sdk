import {
    BlockhashWithExpiryBlockHeight,
    Commitment,
    ComputeBudgetProgram,
    Connection,
    Finality,
    Keypair,
    PublicKey,
    SendTransactionError,
    Transaction,
    TransactionMessage,
    VersionedTransaction,
    VersionedTransactionResponse,
} from "@solana/web3.js";
import {PriorityFee, TransactionResult} from "./types";

export const DEFAULT_COMMITMENT: Commitment = "finalized";
export const DEFAULT_FINALITY: Finality = "finalized";

export const calculateWithSlippageBuy = (
    amount: bigint,
    basisPoints: bigint
) => {
    return amount + (amount * basisPoints) / 10000n;
};

export const calculateWithSlippageSell = (
    amount: bigint,
    basisPoints: bigint
) => {
    return amount - (amount * basisPoints) / 10000n;
};

export async function sendTx(
    connections: Connection[],
    tx: Transaction,
    payer: PublicKey,
    signers: Keypair[],
    priorityFees?: PriorityFee | undefined,
    blockHash?: BlockhashWithExpiryBlockHeight | undefined,
    skipPreflisht: boolean = false,
    commitment: Commitment = DEFAULT_COMMITMENT,
    finality: Finality = DEFAULT_FINALITY
): Promise<TransactionResult> {
    let newTx = new Transaction();

    if (priorityFees) {
        const modifyComputeUnits = ComputeBudgetProgram.setComputeUnitLimit({
            units: priorityFees.unitLimit,
        });

        const addPriorityFee = ComputeBudgetProgram.setComputeUnitPrice({
            microLamports: priorityFees.unitPrice,
        });
        newTx.add(modifyComputeUnits);
        newTx.add(addPriorityFee);
    }

    newTx.add(tx);

    let versionedTx = await buildVersionedTx(connections[0], payer, newTx, blockHash, commitment);
    versionedTx.sign(signers);

    let sig;
    try {
        console.log(connections.length)
        let counter = 0;
        for (let connection of connections) {
            console.log(`RPC: ${counter}`);
            sig = connection.sendTransaction(versionedTx, {
                skipPreflight: skipPreflisht,
            });
            counter++;

        }

        const signature = await sig
        console.log("sig:", `https://solscan.io/tx/${signature}`);

        let txResult = await getTxDetails(connections[0], signature, commitment, finality);
        if (!txResult) {
            return {
                success: false,
                error: "Transaction failed",
            };
        }
        return {
            success: true,
            signature: signature,
            results: txResult,
        };
    } catch (e) {
        if (e instanceof SendTransactionError) {
            console.log(e);
            //throw new Error()
        } else {
            console.error(e);
        }
        return {
            success: false
        };
    }
}

export const buildVersionedTx = async (
    connection: Connection,
    payer: PublicKey,
    tx: Transaction,
    blockHash?: BlockhashWithExpiryBlockHeight,
    commitment: Commitment = DEFAULT_COMMITMENT
): Promise<VersionedTransaction> => {
    if (!blockHash)
        blockHash = (await connection.getLatestBlockhash(commitment))

    let messageV0 = new TransactionMessage({
        payerKey: payer,
        recentBlockhash: blockHash.blockhash,
        instructions: tx.instructions,
    }).compileToV0Message();

    return new VersionedTransaction(messageV0);
};

export const getTxDetails = async (
    connection: Connection,
    sig: string,
    commitment: Commitment = DEFAULT_COMMITMENT,
    finality: Finality = DEFAULT_FINALITY
): Promise<VersionedTransactionResponse | null> => {
    const latestBlockHash = await connection.getLatestBlockhash();
    await connection.confirmTransaction(
        {
            blockhash: latestBlockHash.blockhash,
            lastValidBlockHeight: latestBlockHash.lastValidBlockHeight,
            signature: sig,
        },
        commitment
    );

    return connection.getTransaction(sig, {
        maxSupportedTransactionVersion: 0,
        commitment: finality,
    });
};
