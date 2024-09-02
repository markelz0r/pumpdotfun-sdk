import {
    BlockhashWithExpiryBlockHeight,
    Commitment,
    Connection,
    Finality,
    Keypair,
    PublicKey,
    Transaction,
} from "@solana/web3.js";
import {Program, Provider} from "@coral-xyz/anchor";
import {GlobalAccount} from "./globalAccount";
import {
    CompleteEvent,
    CreateEvent,
    CreateTokenMetadata,
    PriorityFee,
    PumpFunEventHandlers,
    PumpFunEventType,
    SetParamsEvent,
    TradeEvent,
    TransactionResult,
} from "./types";
import {toCompleteEvent, toCreateEvent, toSetParamsEvent, toTradeEvent,} from "./events";
import {
    createAssociatedTokenAccountInstruction,
    createCloseAccountInstruction,
    getAssociatedTokenAddress,
} from "@solana/spl-token";
import {BondingCurveAccount} from "./bondingCurveAccount";
import {BN} from "bn.js";
import {
    calculateWithSlippageBuy,
    calculateWithSlippageSell,
    DEFAULT_COMMITMENT,
    DEFAULT_FINALITY,
    sendTx,
} from "./util";
import {IDL, PumpFun} from "./IDL";

const PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const MPL_TOKEN_METADATA_PROGRAM_ID =
    "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";

export const GLOBAL_ACCOUNT_SEED = "global";
export const MINT_AUTHORITY_SEED = "mint-authority";
export const BONDING_CURVE_SEED = "bonding-curve";
export const METADATA_SEED = "metadata";

export const DEFAULT_DECIMALS = 6;

export class PumpFunSDK {
    public program: Program<PumpFun>;
    public connections: Connection[];

    constructor(connections: Connection[], provider?: Provider) {
        console.log(connections.length)
        this.program = new Program<PumpFun>(IDL as PumpFun, provider);
        this.connections = connections;
    }

    async makeCreateAndBuyTx(createTokenMetadata: CreateTokenMetadata, creator: Keypair, mint: Keypair, buyAmountSol: bigint, commitment: "processed" | "confirmed" | "finalized" | "recent" | "single" | "singleGossip" | "root" | "max", slippageBasisPoints: bigint) {
        let tokenMetadata = await this.createTokenMetadata(createTokenMetadata);

        let createTx = await this.getCreateInstructions(
            creator.publicKey,
            createTokenMetadata.name,
            createTokenMetadata.symbol,
            tokenMetadata.metadataUri,
            mint
        );

        let newTx = new Transaction().add(createTx);

        if (buyAmountSol > 0) {
            const buyTx = await this.makeBuyTx(commitment, buyAmountSol, slippageBasisPoints, creator.publicKey, mint.publicKey);
            newTx.add(buyTx);
        }

        return newTx;
    }

    async makeBuyTx(commitment: "processed" | "confirmed" | "finalized" | "recent" | "single" | "singleGossip" | "root" | "max", buyAmountSol: bigint, slippageBasisPoints: bigint, buyer: PublicKey, mint: PublicKey) {
        const globalAccount = await this.getGlobalAccount(commitment);
        const buyAmount = globalAccount.getInitialBuyPrice(buyAmountSol);
        const buyAmountWithSlippage = calculateWithSlippageBuy(
            buyAmountSol,
            slippageBasisPoints
        );

        return await this.getBuyInstructions(
            buyer,
            mint,
            globalAccount.feeRecipient,
            buyAmount,
            buyAmountWithSlippage
        );
    }

    async makeBuyTxFixedAmount(buyer: PublicKey, amount: bigint, maxSolCost: bigint, mint: PublicKey, feeRecipient: PublicKey) {
        return await this.getBuyInstructions(
            buyer,
            mint,
            feeRecipient,
            amount,
            maxSolCost
        );
    }

    async createAndBuy(
        creator: Keypair,
        mint: Keypair,
        createTokenMetadata: CreateTokenMetadata,
        buyAmountSol: bigint,
        slippageBasisPoints: bigint = 500n,
        priorityFees?: PriorityFee,
        commitment: Commitment = DEFAULT_COMMITMENT,
        finality: Finality = DEFAULT_FINALITY
    ): Promise<TransactionResult> {
        let newTx = await this.makeCreateAndBuyTx(createTokenMetadata, creator, mint, buyAmountSol, commitment, slippageBasisPoints);

        return await sendTx(this.connections, newTx, creator.publicKey, [creator, mint], priorityFees, undefined, false, commitment, finality);
    }

    async buy(
        buyer: Keypair,
        mint: PublicKey,
        buyAmountSol: bigint,
        slippageBasisPoints: bigint = 500n,
        priorityFees?: PriorityFee,
        blockHash?: BlockhashWithExpiryBlockHeight,
        commitment: Commitment = DEFAULT_COMMITMENT,
        finality: Finality = DEFAULT_FINALITY
    ): Promise<TransactionResult> {
        let buyTx = await this.getBuyInstructionsBySolAmount(
            buyer.publicKey,
            mint,
            buyAmountSol,
            slippageBasisPoints,
            commitment
        );

        return await sendTx(this.connections, buyTx, buyer.publicKey, [buyer], priorityFees, blockHash, false, commitment, finality);
    }

    async buyFixed(
        buyTx: Transaction,
        buyer: Keypair,
        priorityFees?: PriorityFee,
        blockHash?: BlockhashWithExpiryBlockHeight,
        commitment: Commitment = DEFAULT_COMMITMENT, finality: Finality = DEFAULT_FINALITY)
    {
        return await sendTx(this.connections, buyTx, buyer.publicKey, [buyer], priorityFees, blockHash, true, commitment, finality);
    }

    async sell(
        seller: Keypair,
        mint: PublicKey,
        sellTokenAmount: bigint,
        slippageBasisPoints: bigint = 500n,
        priorityFees?: PriorityFee,
        blockHash?: BlockhashWithExpiryBlockHeight,
        commitment: Commitment = DEFAULT_COMMITMENT,
        finality: Finality = DEFAULT_FINALITY
    ): Promise<TransactionResult> {
        let sellTx = await this.makeSellTx(seller, mint, sellTokenAmount, slippageBasisPoints, commitment);

        return await sendTx(
            this.connections,
            sellTx,
            seller.publicKey,
            [seller],
            priorityFees,
            blockHash,
            false,
            commitment,
            finality
        );
    }

    public async makeSellTx(seller: Keypair, mint: PublicKey, sellTokenAmount: bigint, slippageBasisPoints: bigint, commitment: "processed" | "confirmed" | "finalized" | "recent" | "single" | "singleGossip" | "root" | "max") {
        return await this.getSellInstructionsByTokenAmount(
            seller.publicKey,
            mint,
            sellTokenAmount,
            slippageBasisPoints,
            commitment
        );
    }

//create token instructions
    async getCreateInstructions(
        creator: PublicKey,
        name: string,
        symbol: string,
        uri: string,
        mint: Keypair
    ) {
        const mplTokenMetadata = new PublicKey(MPL_TOKEN_METADATA_PROGRAM_ID);

        const [metadataPDA] = PublicKey.findProgramAddressSync(
            [
                Buffer.from(METADATA_SEED),
                mplTokenMetadata.toBuffer(),
                mint.publicKey.toBuffer(),
            ],
            mplTokenMetadata
        );

        const associatedBondingCurve = await getAssociatedTokenAddress(
            mint.publicKey,
            this.getBondingCurvePDA(mint.publicKey),
            true
        );

        return this.program.methods
            .create(name, symbol, uri)
            .accounts({
                mint: mint.publicKey,
                associatedBondingCurve: associatedBondingCurve,
                metadata: metadataPDA,
                user: creator,
            })
            .signers([mint])
            .transaction();
    }

    async getBuyInstructionsBySolAmount(
        buyer: PublicKey,
        mint: PublicKey,
        buyAmountSol: bigint,
        slippageBasisPoints: bigint = 500n,
        commitment: Commitment = DEFAULT_COMMITMENT
    ) {
        let bondingCurveAccount = await this.getBondingCurveAccount(
            mint,
            commitment
        );
        if (!bondingCurveAccount) {
            throw new Error(`Bonding curve account not found: ${mint.toBase58()}`);
        }

        let buyAmount = bondingCurveAccount.getBuyPrice(buyAmountSol);
        let buyAmountWithSlippage = calculateWithSlippageBuy(
            buyAmountSol,
            slippageBasisPoints
        );

        let globalAccount = await this.getGlobalAccount(commitment);

        return await this.getBuyInstructions(
            buyer,
            mint,
            globalAccount.feeRecipient,
            buyAmount,
            buyAmountWithSlippage
        );
    }

    //buy
    async getBuyInstructions(
        buyer: PublicKey,
        mint: PublicKey,
        feeRecipient: PublicKey,
        amount: bigint,
        solAmount: bigint,
        commitment: Commitment = DEFAULT_COMMITMENT
    ) {
        const associatedBondingCurve = await getAssociatedTokenAddress(
            mint,
            this.getBondingCurvePDA(mint),
            true
        );

        const associatedUser = await getAssociatedTokenAddress(mint, buyer, false);

        let transaction = new Transaction();

        transaction.add(
            createAssociatedTokenAccountInstruction(
                buyer,
                associatedUser,
                buyer,
                mint
            )
        );

        transaction.add(
            await this.program.methods
                .buy(new BN(amount.toString()), new BN(solAmount.toString()))
                .accounts({
                    feeRecipient: feeRecipient,
                    mint: mint,
                    associatedBondingCurve: associatedBondingCurve,
                    associatedUser: associatedUser,
                    user: buyer,
                })
                .transaction()
        );

        return transaction;
    }

    //sell
    async getSellInstructionsByTokenAmount(
        seller: PublicKey,
        mint: PublicKey,
        sellTokenAmount: bigint,
        slippageBasisPoints: bigint = 500n,
        commitment: Commitment = DEFAULT_COMMITMENT
    ) {
        let bondingCurveAccount = await this.getBondingCurveAccount(
            mint,
            commitment
        );
        if (!bondingCurveAccount) {
            throw new Error(`Bonding curve account not found: ${mint.toBase58()}`);
        }

        let globalAccount = await this.getGlobalAccount(commitment);

        let minSolOutput = bondingCurveAccount.getSellPrice(
            sellTokenAmount,
            globalAccount.feeBasisPoints
        );

        let sellAmountWithSlippage = calculateWithSlippageSell(
            minSolOutput,
            slippageBasisPoints
        );

        return await this.getSellInstructions(
            seller,
            mint,
            globalAccount.feeRecipient,
            sellTokenAmount,
            sellAmountWithSlippage
        );
    }

    async getSellInstructions(
        seller: PublicKey,
        mint: PublicKey,
        feeRecipient: PublicKey,
        amount: bigint,
        minSolOutput: bigint,
    ) {
        const associatedBondingCurve = await getAssociatedTokenAddress(
            mint,
            this.getBondingCurvePDA(mint),
            true
        );

        const associatedUser = await getAssociatedTokenAddress(mint, seller, false);

        let transaction = new Transaction();

        transaction.add(
            await this.program.methods
                .sell(new BN(amount.toString()), new BN(minSolOutput.toString()))
                .accounts({
                    feeRecipient: feeRecipient,
                    mint: mint,
                    associatedBondingCurve: associatedBondingCurve,
                    associatedUser: associatedUser,
                    user: seller,
                })
                .transaction()
        );

        transaction.add(createCloseAccountInstruction(associatedUser, seller, seller))

        return transaction;
    }

    async getBondingCurveAccount(
        mint: PublicKey,
        commitment: Commitment = DEFAULT_COMMITMENT
    ) {
        const tokenAccount = await this.connections[0].getAccountInfo(
            this.getBondingCurvePDA(mint),
            commitment
        );
        if (!tokenAccount) {
            return null;
        }
        return BondingCurveAccount.fromBuffer(tokenAccount!.data);
    }

    async getGlobalAccount(commitment: Commitment = DEFAULT_COMMITMENT) {
        const [globalAccountPDA] = PublicKey.findProgramAddressSync(
            [Buffer.from(GLOBAL_ACCOUNT_SEED)],
            new PublicKey(PROGRAM_ID)
        );

        const tokenAccount = await this.connections[0].getAccountInfo(
            globalAccountPDA,
            commitment
        );

        return GlobalAccount.fromBuffer(tokenAccount!.data);
    }

    getBondingCurvePDA(mint: PublicKey) {
        return PublicKey.findProgramAddressSync(
            [Buffer.from(BONDING_CURVE_SEED), mint.toBuffer()],
            this.program.programId
        )[0];
    }

    async createTokenMetadata(create: CreateTokenMetadata) {
        let formData = new FormData();
        formData.append("file", create.file),
            formData.append("name", create.name),
            formData.append("symbol", create.symbol),
            formData.append("description", create.description),
            formData.append("twitter", create.twitter || ""),
            formData.append("telegram", create.telegram || ""),
            formData.append("website", create.website || ""),
            formData.append("showName", "true");
        let request = await fetch("https://pump.fun/api/ipfs", {
            method: "POST",
            body: formData,
        });
        return request.json();
    }

    //EVENTS
    addEventListener<T extends PumpFunEventType>(
        eventType: T,
        callback: (
            event: PumpFunEventHandlers[T],
            slot: number,
            signature: string
        ) => void
    ) {
        return this.program.addEventListener(
            eventType,
            (event: any, slot: number, signature: string) => {
                let processedEvent;
                switch (eventType) {
                    case "createEvent":
                        processedEvent = toCreateEvent(event as CreateEvent);
                        callback(
                            processedEvent as PumpFunEventHandlers[T],
                            slot,
                            signature
                        );
                        break;
                    case "tradeEvent":
                        processedEvent = toTradeEvent(event as TradeEvent);
                        callback(
                            processedEvent as PumpFunEventHandlers[T],
                            slot,
                            signature
                        );
                        break;
                    case "completeEvent":
                        processedEvent = toCompleteEvent(event as CompleteEvent);
                        callback(
                            processedEvent as PumpFunEventHandlers[T],
                            slot,
                            signature
                        );
                        console.log("completeEvent", event, slot, signature);
                        break;
                    case "setParamsEvent":
                        processedEvent = toSetParamsEvent(event as SetParamsEvent);
                        callback(
                            processedEvent as PumpFunEventHandlers[T],
                            slot,
                            signature
                        );
                        break;
                    default:
                        console.error("Unhandled event type:", eventType);
                }
            }
        );
    }

    removeEventListener(eventId: number) {
        this.program.removeEventListener(eventId);
    }
}
