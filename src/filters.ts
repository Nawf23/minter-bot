/**
 * Smart filtering to distinguish NFT mints from token operations
 */

// Known ERC-20 token operations to IGNORE
const TOKEN_FUNCTION_BLACKLIST = [
    '0xa9059cbb', // transfer(address,uint256)
    '0x095ea7b3', // approve(address,uint256)
    '0x23b872dd', // transferFrom(address,address,uint256)
    '0x38ed1739', // swapExactTokensForTokens (Uniswap V2)
    '0xfb3bdb41', // swapETHForExactTokens (Uniswap V2)
    '0x7ff36ab5', // swapExactETHForTokens (Uniswap V2)
    '0x18cbafe5', // swapExactTokensForETH (Uniswap V2)
    '0x5c11d795', // swapExactTokensForTokensSupportingFeeOnTransferTokens
    '0xb6f9de95', // swapExactETHForTokensSupportingFeeOnTransferTokens
];

// Known NFT mint functions to ALLOW
const MINT_FUNCTION_WHITELIST = [
    '0x1249c58b', // mint()
    '0x6a627842', // mint(address)
    '0xa0712d68', // mint(uint256)
    '0x2db11544', // publicMint()
    '0x4e71d92d', // claim()
    '0x84bb1e42', // freeMint()
    '0x40c10f19', // mint(address,uint256) - common for ERC721
];

/**
 * Determines if a transaction is likely an NFT mint
 * @param txData - Transaction calldata (hex string starting with 0x)
 * @returns true if likely an NFT mint, false otherwise
 */
export function isLikelyNFTMint(txData: string): boolean {
    if (!txData || txData === '0x') return false;

    const functionSig = txData.substring(0, 10).toLowerCase(); // First 4 bytes (0x + 8 hex chars)

    // Layer 1: Blacklist check - reject known token operations
    if (TOKEN_FUNCTION_BLACKLIST.includes(functionSig)) {
        console.log(`  🚫 Filtered: Known token operation (${functionSig})`);
        return false;
    }

    // Layer 2: Whitelist check - accept known mint functions
    if (MINT_FUNCTION_WHITELIST.includes(functionSig)) {
        console.log(`  ✅ Matched: Known NFT mint function (${functionSig})`);
        return true;
    }

    // Layer 3: Heuristic checks for unknown signatures
    const dataLength = txData.length;

    // Very short calldata (< 200 chars = ~100 bytes) often means simple mint
    if (dataLength < 200) {
        console.log(`  ✅ Heuristic: Short calldata (${dataLength} chars) - likely simple mint`);
        return true;
    }

    // Very long calldata (> 1000 chars = ~500 bytes) often means complex swap
    if (dataLength > 1000) {
        console.log(`  ⏭️ Heuristic: Long calldata (${dataLength} chars) - likely swap/complex interaction`);
        return false;
    }

    // Medium-length unknown signature: be cautious, allow it
    console.log(`  ⚠️ Unknown function signature (${functionSig}), allowing as potential mint`);
    return true;
}

/**
 * Get a human-readable description of why a transaction was filtered
 */
export function getFilterReason(txData: string): string {
    if (!txData || txData === '0x') return 'No calldata';

    const functionSig = txData.substring(0, 10).toLowerCase();

    if (TOKEN_FUNCTION_BLACKLIST.includes(functionSig)) {
        return 'Token operation (transfer/approve/swap)';
    }

    if (MINT_FUNCTION_WHITELIST.includes(functionSig)) {
        return 'Known NFT mint function';
    }

    const dataLength = txData.length;
    if (dataLength > 1000) {
        return 'Complex interaction (likely swap)';
    }

    return 'Potential NFT mint';
}
