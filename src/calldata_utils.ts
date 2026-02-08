import { ethers } from 'ethers';

/**
 * Replace recipient address in mint calldata
 * Handles common mint function signatures that include an address parameter
 */
export function replaceRecipientInCalldata(
    originalData: string,
    newRecipient: string
): string {
    // Extract function selector (first 4 bytes = 10 hex chars including 0x)
    const functionSig = originalData.substring(0, 10);
    const params = originalData.substring(10);

    // mint(address to, uint256 tokenId) - 0x40c10f19
    // This is the most common pattern
    if (functionSig === '0x40c10f19') {
        try {
            // Decode: [address, uint256]
            const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
                ['address', 'uint256'],
                '0x' + params
            );

            // Re-encode with bot's address
            const newParams = ethers.AbiCoder.defaultAbiCoder().encode(
                ['address', 'uint256'],
                [newRecipient, decoded[1]]  // Replace address, keep tokenId
            );

            // Return: functionSig + newParams (without 0x prefix)
            return functionSig + newParams.substring(2);
        } catch (err) {
            console.error('Failed to decode mint(address,uint256):', err);
            return originalData;  // Return original if decode fails
        }
    }

    // mint(address to) - 0x6a627842
    if (functionSig === '0x6a627842') {
        try {
            // Just one address parameter - replace it
            const newParams = ethers.AbiCoder.defaultAbiCoder().encode(
                ['address'],
                [newRecipient]
            );
            return functionSig + newParams.substring(2);
        } catch (err) {
            console.error('Failed to decode mint(address):', err);
            return originalData;
        }
    }

    // For functions without address parameters, return original
    // mint() - 0x1249c58b
    // mint(uint256) - 0xa0712d68  
    // publicMint() - 0x2db11544
    // claim() - 0x4e71d92d
    // etc.

    return originalData;
}

/**
 * Check if calldata contains an address parameter that needs replacement
 */
export function needsAddressReplacement(data: string): boolean {
    const functionSig = data.substring(0, 10);

    // Known functions that take address as recipient
    const addressMintFunctions = [
        '0x40c10f19',  // mint(address,uint256)
        '0x6a627842',  // mint(address)
    ];

    return addressMintFunctions.includes(functionSig);
}
