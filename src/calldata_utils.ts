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

    // SeaDrop mintPublic(address nftContract, address feeRecipient, address minterIfNotPayer, uint256 quantity)
    // Only replace minterIfNotPayer (param index 2)
    if (functionSig === '0x26bf076a') {
        try {
            const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
                ['address', 'address', 'address', 'uint256'],
                '0x' + params
            );
            const newParams = ethers.AbiCoder.defaultAbiCoder().encode(
                ['address', 'address', 'address', 'uint256'],
                [decoded[0], decoded[1], newRecipient, decoded[3]]  // Only replace minterIfNotPayer
            );
            console.log(`  ⚙️ SeaDrop mintPublic: replaced minterIfNotPayer`);
            return functionSig + newParams.substring(2);
        } catch (err) {
            console.error('Failed to decode SeaDrop mintPublic:', err);
            return originalData;
        }
    }

    // SeaDrop mintSigned(address nftContract, address feeRecipient, address minter, uint256 quantity, ...)
    // This has additional params (MintParams struct, salt, signature) but we only need to replace
    // the minter address at position 2. Use generic replacement ONLY for the minter position.
    if (functionSig === '0x4b61cd6f') {
        // For mintSigned, the calldata is complex (struct + signature). We can't easily ABI-decode
        // the full thing. Instead, we know the first 3 address params are at fixed 32-byte slots:
        // Slot 0 (chars 0-63): nftContract
        // Slot 1 (chars 64-127): feeRecipient  
        // Slot 2 (chars 128-191): minter ← ONLY replace this one
        if (params.length >= 192) {
            const slot0 = params.substring(0, 64);    // nftContract - DON'T TOUCH
            const slot1 = params.substring(64, 128);  // feeRecipient - DON'T TOUCH
            // slot2 = minter - REPLACE
            const recipientPadded = newRecipient.toLowerCase().replace('0x', '').padStart(64, '0');
            const rest = params.substring(192);        // quantity + MintParams + salt + signature
            console.log(`  ⚙️ SeaDrop mintSigned: replaced minter at slot 2`);
            return functionSig + slot0 + slot1 + recipientPadded + rest;
        }
        return originalData;
    }

    // SeaDrop mintAllowList - same parameter layout as mintSigned for first 3 params
    if (functionSig === '0x2e69ed7f' || functionSig === '0x6ab93230') {
        if (params.length >= 192) {
            const slot0 = params.substring(0, 64);    // nftContract - DON'T TOUCH
            const slot1 = params.substring(64, 128);  // feeRecipient - DON'T TOUCH
            const recipientPadded = newRecipient.toLowerCase().replace('0x', '').padStart(64, '0');
            const rest = params.substring(192);
            console.log(`  ⚙️ SeaDrop mintAllowList: replaced minter at slot 2`);
            return functionSig + slot0 + slot1 + recipientPadded + rest;
        }
        return originalData;
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
        // SeaDrop functions (minter address at param index 2)
        '0x4b61cd6f',  // mintSigned
        '0x26bf076a',  // mintPublic
        '0x2e69ed7f',  // mintAllowList
        '0x6ab93230',  // mintAllowedTokenHolder
    ];

    return addressMintFunctions.includes(functionSig);
}

/**
 * GENERIC address replacement: scans ABI-encoded calldata for any occurrence
 * of the original sender's address and replaces it with the new address.
 * 
 * This handles ANY function signature where the tracked wallet's address
 * appears as a parameter (e.g. claim, mintTo, safeMint, thirdweb claims, etc.)
 * 
 * Addresses in ABI-encoded data are left-padded to 32 bytes, so we search
 * for the zero-padded address pattern.
 */
export function genericReplaceAddress(
    calldata: string,
    originalAddress: string,
    newAddress: string
): { data: string; replacements: number } {
    // Normalize addresses: lowercase, no 0x prefix, zero-padded to 64 chars
    const originalPadded = originalAddress.toLowerCase().replace('0x', '').padStart(64, '0');
    const newPadded = newAddress.toLowerCase().replace('0x', '').padStart(64, '0');

    // SAFEGUARD: If addresses are identical, return original to avoid infinite loop
    if (originalPadded === newPadded) {
        return { data: calldata, replacements: 0 };
    }

    // Only search in the params section (after the 4-byte function selector)
    const selector = calldata.substring(0, 10); // "0x" + 8 hex chars
    let params = calldata.substring(10);

    // Count and replace all occurrences
    let replacements = 0;
    while (params.toLowerCase().includes(originalPadded)) {
        // Case-insensitive replacement (addresses can be mixed case)
        const idx = params.toLowerCase().indexOf(originalPadded);
        params = params.substring(0, idx) + newPadded + params.substring(idx + originalPadded.length);
        replacements++;
    }

    return {
        data: selector + params,
        replacements
    };
}

/**
 * Check if calldata contains a specific address in its ABI-encoded parameters.
 * Used to determine if generic replacement is needed.
 */
export function calldataContainsAddress(data: string, address: string): boolean {
    const paddedAddress = address.toLowerCase().replace('0x', '').padStart(64, '0');
    const params = data.substring(10).toLowerCase();
    return params.includes(paddedAddress);
}
