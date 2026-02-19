import { ethers } from 'ethers';

const rpcProviderPool: Record<string, ethers.JsonRpcProvider> = {};

/**
 * Returns a cached JsonRpcProvider for the given URL.
 * Uses staticNetwork: true to prevent unnecessary 'eth_chainId' calls.
 */
export function getSharedProvider(rpcUrl: string): ethers.JsonRpcProvider {
    if (!rpcProviderPool[rpcUrl]) {
        rpcProviderPool[rpcUrl] = new ethers.JsonRpcProvider(rpcUrl, undefined, {
            staticNetwork: true,
            batchMaxCount: 1
        });
    }
    return rpcProviderPool[rpcUrl];
}
