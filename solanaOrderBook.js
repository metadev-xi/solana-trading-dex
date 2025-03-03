/**
 * SOLANA Trading DEX - Order Book Implementation
 * 
 * This core module implements the on-chain order book functionality
 * for the SOLANA Trading DEX, handling limit orders, market orders,
 * and order matching logic with Serum integration.
 */

const { Connection, PublicKey, Transaction, TransactionInstruction } = require('@solana/web3.js');
const { Market, OpenOrders } = require('@project-serum/serum');
const { Token } = require('@solana/spl-token');
const BN = require('bn.js');

// Constants for the DEX
const SERUM_PROGRAM_ID = new PublicKey('9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin');
const FEE_RECIPIENT = new PublicKey('FeeRecipientAddressHere11111111111111111');
const REFERRAL_FEE_RATE = 0.003; // 0.3%
const TAKER_FEE_RATE = 0.0022;   // 0.22%
const MAKER_FEE_RATE = -0.0003;  // -0.03% (rebate)

class SolanaOrderBook {
  /**
   * Initialize the Solana order book system
   * @param {Object} config - Configuration options
   */
  constructor(config) {
    this.connection = new Connection(config.rpcEndpoint || 'https://api.mainnet-beta.solana.com');
    this.marketCache = new Map();
    this.marketProgramId = new PublicKey(config.serumProgramId || SERUM_PROGRAM_ID);
    this.feeDiscountPubkey = config.feeDiscountPubkey ? new PublicKey(config.feeDiscountPubkey) : null;
  }

  /**
   * Get market information and initialize Market object
   * @param {string} marketAddress - Address of the market
   * @returns {Promise<Market>} Market object
   */
  async getMarket(marketAddress) {
    try {
      if (this.marketCache.has(marketAddress)) {
        return this.marketCache.get(marketAddress);
      }

      const marketPubkey = new PublicKey(marketAddress);
      const market = await Market.load(
        this.connection,
        marketPubkey,
        {},
        this.marketProgramId
      );

      this.marketCache.set(marketAddress, market);
      return market;
    } catch (error) {
      console.error(`Error loading market ${marketAddress}:`, error);
      throw new Error(`Failed to load market: ${error.message}`);
    }
  }

  /**
   * Get the current order book for a market
   * @param {string} marketAddress - Address of the market
   * @param {number} depth - Depth of the order book to retrieve
   * @returns {Promise<Object>} The order book with bids and asks
   */
  async getOrderBook(marketAddress, depth = 20) {
    try {
      const market = await this.getMarket(marketAddress);
      const [bids, asks] = await Promise.all([
        market.loadBids(this.connection),
        market.loadAsks(this.connection)
      ]);

      // Process bids
      const bidItems = [];
      for (const [price, size, orderId] of bids.getL2(depth)) {
        bidItems.push({
          price,
          size,
          orderId: orderId.toString(),
          side: 'buy'
        });
      }

      // Process asks
      const askItems = [];
      for (const [price, size, orderId] of asks.getL2(depth)) {
        askItems.push({
          price,
          size,
          orderId: orderId.toString(),
          side: 'sell'
        });
      }

      // Calculate spread
      const bestBid = bidItems.length > 0 ? bidItems[0].price : 0;
      const bestAsk = askItems.length > 0 ? askItems[0].price : 0;
      const spread = bestAsk - bestBid;
      const spreadPercentage = bestBid > 0 ? (spread / bestBid) * 100 : 0;

      return {
        market: marketAddress,
        bids: bidItems,
        asks: askItems,
        spread,
        spreadPercentage,
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      console.error(`Error fetching order book for ${marketAddress}:`, error);
      throw new Error(`Failed to fetch order book: ${error.message}`);
    }
  }

  /**
   * Place a limit order on the market
   * @param {Object} params - Order parameters
   * @returns {Promise<Object>} Result of order placement
   */
  async placeLimitOrder(params) {
    const {
      marketAddress,
      wallet,
      side,
      price,
      size,
      orderType = 'limit',
      clientId,
      selfTradeBehavior = 'decrementTake',
    } = params;

    try {
      const market = await this.getMarket(marketAddress);
      
      // Get or create OpenOrders account
      let openOrdersAccounts = await market.findOpenOrdersAccountsForOwner(
        this.connection,
        wallet.publicKey
      );
      
      // Use existing or create new OpenOrders account
      let openOrdersAddress;
      if (openOrdersAccounts.length === 0) {
        const transaction = new Transaction();
        
        // Create instruction for a new OpenOrders account
        const instruction = await OpenOrders.makeCreateAccountTransaction(
          this.connection,
          market.address,
          wallet.publicKey,
          undefined,
          this.marketProgramId
        );
        
        transaction.add(instruction);
        const txid = await this.connection.sendTransaction(transaction, [wallet], {
          skipPreflight: false,
          preflightCommitment: 'processed'
        });
        
        // Wait for confirmation
        await this.connection.confirmTransaction(txid);
        
        // Refresh OpenOrders accounts
        openOrdersAccounts = await market.findOpenOrdersAccountsForOwner(
          this.connection,
          wallet.publicKey
        );
      }
      
      // Use the first OpenOrders account
      openOrdersAddress = openOrdersAccounts[0].address;
      
      // Convert price and size to lots
      const priceLots = market.priceNumberToLots(price);
      const sizeLots = market.baseSizeNumberToLots(size);
      
      // Build the order placement transaction
      const transaction = new Transaction();
      
      transaction.add(
        market.makePlaceOrderInstruction({
          owner: wallet.publicKey,
          payer: side === 'buy' ? wallet.publicKey : openOrdersAddress,
          side,
          price: priceLots,
          size: sizeLots,
          orderType,
          clientId: clientId ? new BN(clientId) : undefined,
          openOrdersAddressKey: openOrdersAddress,
          feeDiscountPubkey: this.feeDiscountPubkey,
          selfTradeBehavior
        })
      );
      
      // Sign and send the transaction
      const txid = await this.connection.sendTransaction(transaction, [wallet], {
        skipPreflight: false,
        preflightCommitment: 'confirmed'
      });
      
      return {
        success: true,
        txid,
        market: marketAddress,
        side,
        price,
        size,
        orderType,
        clientId: clientId ? clientId.toString() : undefined
      };
    } catch (error) {
      console.error('Error placing limit order:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Place a market order on the exchange
   * @param {Object} params - Order parameters
   * @returns {Promise<Object>} Result of order placement
   */
  async placeMarketOrder(params) {
    const {
      marketAddress,
      wallet,
      side,
      size,
      orderType = 'ioc', // Immediate-or-cancel
      clientId
    } = params;

    try {
      const market = await this.getMarket(marketAddress);
      
      // For market orders, we need the current order book to estimate price
      const orderBook = await this.getOrderBook(marketAddress);
      
      // Estimate price based on order book and size
      let estimatedPrice;
      if (side === 'buy') {
        // For buy orders, use asks (sell orders)
        estimatedPrice = this.estimateMarketOrderPrice(orderBook.asks, size, side);
      } else {
        // For sell orders, use bids (buy orders)
        estimatedPrice = this.estimateMarketOrderPrice(orderBook.bids, size, side);
      }
      
      // Place the order with the estimated price
      return await this.placeLimitOrder({
        marketAddress,
        wallet,
        side,
        price: estimatedPrice * 1.05, // Add 5% slippage protection for buys, or use 0.95 for sells
        size,
        orderType,
        clientId
      });
    } catch (error) {
      console.error('Error placing market order:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Estimate the effective price for a market order based on the order book
   * @param {Array} orders - The orders from the order book (bids or asks)
   * @param {number} size - The size of the order
   * @param {string} side - The side of the order (buy or sell)
   * @returns {number} Estimated effective price
   */
  estimateMarketOrderPrice(orders, size, side) {
    let remainingSize = size;
    let totalCost = 0;
    
    for (const order of orders) {
      const sizeToTake = Math.min(remainingSize, order.size);
      totalCost += sizeToTake * order.price;
      remainingSize -= sizeToTake;
      
      if (remainingSize <= 0) {
        break;
      }
    }
    
    // If we couldn't fill the entire order with the available liquidity
    if (remainingSize > 0) {
      throw new Error('Insufficient liquidity to execute market order of this size');
    }
    
    return totalCost / size;
  }

  /**
   * Cancel an order
   * @param {Object} params - Cancel parameters
   * @returns {Promise<Object>} Result of cancellation
   */
  async cancelOrder(params) {
    const {
      marketAddress,
      wallet,
      orderId,
      side,
      openOrdersAddress
    } = params;

    try {
      const market = await this.getMarket(marketAddress);
      
      // Find OpenOrders account if not provided
      let openOrdersAccount = openOrdersAddress 
        ? new PublicKey(openOrdersAddress)
        : (await market.findOpenOrdersAccountsForOwner(
            this.connection,
            wallet.publicKey
          ))[0].address;
      
      // Create a transaction to cancel the order
      const transaction = new Transaction();
      
      transaction.add(
        market.makeCancelOrderInstruction({
          owner: wallet.publicKey,
          openOrders: openOrdersAccount,
          orderId: new BN(orderId),
          side
        })
      );
      
      // Sign and send the transaction
      const txid = await this.connection.sendTransaction(transaction, [wallet], {
        skipPreflight: false,
        preflightCommitment: 'confirmed'
      });
      
      return {
        success: true,
        txid,
        market: marketAddress,
        orderId
      };
    } catch (error) {
      console.error('Error cancelling order:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Settle funds (convert wrapped SOL to SOL, move tokens to wallet)
   * @param {Object} params - Settlement parameters
   * @returns {Promise<Object>} Result of settlement
   */
  async settleFunds(params) {
    const {
      marketAddress,
      wallet,
      openOrdersAddress
    } = params;

    try {
      const market = await this.getMarket(marketAddress);
      
      // Find OpenOrders account if not provided
      let openOrdersAccounts;
      if (openOrdersAddress) {
        openOrdersAccounts = [
          { address: new PublicKey(openOrdersAddress) }
        ];
      } else {
        openOrdersAccounts = await market.findOpenOrdersAccountsForOwner(
          this.connection,
          wallet.publicKey
        );
      }
      
      if (openOrdersAccounts.length === 0) {
        return {
          success: false,
          error: 'No open orders account found'
        };
      }
      
      // Create a transaction to settle funds
      const transaction = new Transaction();
      
      // Add settle funds instruction for each OpenOrders account
      for (const openOrders of openOrdersAccounts) {
        transaction.add(
          market.makeSettleFundsTransaction(
            this.connection,
            openOrders,
            wallet.publicKey,
            wallet.publicKey
          ).instructions[0]
        );
      }
      
      // Sign and send the transaction
      const txid = await this.connection.sendTransaction(transaction, [wallet], {
        skipPreflight: false,
        preflightCommitment: 'confirmed'
      });
      
      return {
        success: true,
        txid,
        market: marketAddress
      };
    } catch (error) {
      console.error('Error settling funds:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Get open orders for a user
   * @param {Object} params - Query parameters
   * @returns {Promise<Array>} Array of open orders
   */
  async getOpenOrders(params) {
    const {
      marketAddress,
      walletAddress
    } = params;

    try {
      const market = await this.getMarket(marketAddress);
      const walletPublicKey = new PublicKey(walletAddress);
      
      // Find all OpenOrders accounts for this wallet
      const openOrdersAccounts = await market.findOpenOrdersAccountsForOwner(
        this.connection,
        walletPublicKey
      );
      
      // Get all open orders
      const openOrders = [];
      
      for (const account of openOrdersAccounts) {
        // Load the orders for this account
        const orders = await market.loadOrdersForOwner(
          this.connection,
          walletPublicKey
        );
        
        // Format and add each order to our result array
        for (const order of orders) {
          openOrders.push({
            orderId: order.orderId.toString(),
            marketAddress,
            price: order.price,
            size: order.size,
            side: order.side,
            openOrdersAddress: account.address.toString(),
            clientId: order.clientId ? order.clientId.toString() : undefined,
            feeTier: order.feeTier
          });
        }
      }
      
      return openOrders;
    } catch (error) {
      console.error('Error fetching open orders:', error);
      throw new Error(`Failed to fetch open orders: ${error.message}`);
    }
  }

  /**
   * Get recent trade history for a market
   * @param {string} marketAddress - Address of the market
   * @param {number} limit - Number of trades to fetch
   * @returns {Promise<Array>} Recent trades
   */
  async getRecentTrades(marketAddress, limit = 100) {
    try {
      const market = await this.getMarket(marketAddress);
      
      // Fetch fills from the market
      const fills = await market.loadFills(this.connection, limit);
      
      // Format the trades
      return fills.map(fill => ({
        price: fill.price,
        size: fill.size,
        side: fill.side,
        time: new Date(fill.eventTimestamp * 1000).toISOString(),
        feeCost: fill.feeCost,
        marketAddress
      }));
    } catch (error) {
      console.error('Error fetching recent trades:', error);
      throw new Error(`Failed to fetch recent trades: ${error.message}`);
    }
  }

  /**
   * Get market stats
   * @param {string} marketAddress - Address of the market
   * @returns {Promise<Object>} Market statistics
   */
  async getMarketStats(marketAddress) {
    try {
      const market = await this.getMarket(marketAddress);
      const orderBook = await this.getOrderBook(marketAddress);
      const recentTrades = await this.getRecentTrades(marketAddress, 100);
      
      // Calculate basic statistics
      const lastPrice = recentTrades.length > 0 ? recentTrades[0].price : 0;
      
      // Calculate 24h price change
      const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
      const oldestTradeInWindow = recentTrades
        .filter(trade => new Date(trade.time).getTime() >= oneDayAgo)
        .pop();
      
      const priceChange = oldestTradeInWindow 
        ? (lastPrice - oldestTradeInWindow.price) / oldestTradeInWindow.price * 100
        : 0;
      
      // Calculate 24h volume
      const volume24h = recentTrades
        .filter(trade => new Date(trade.time).getTime() >= oneDayAgo)
        .reduce((total, trade) => total + (trade.price * trade.size), 0);
      
      // Calculate high, low in 24h
      const trades24h = recentTrades.filter(
        trade => new Date(trade.time).getTime() >= oneDayAgo
      );
      
      const high24h = trades24h.length > 0 
        ? Math.max(...trades24h.map(trade => trade.price))
        : lastPrice;
      
      const low24h = trades24h.length > 0
        ? Math.min(...trades24h.map(trade => trade.price))
        : lastPrice;
      
      return {
        marketAddress,
        lastPrice,
        priceChange,
        volume24h,
        high24h,
        low24h,
        bestBid: orderBook.bids.length > 0 ? orderBook.bids[0].price : 0,
        bestAsk: orderBook.asks.length > 0 ? orderBook.asks[0].price : 0,
        spread: orderBook.spread,
        spreadPercentage: orderBook.spreadPercentage,
        baseVolume24h: trades24h.reduce((total, trade) => total + trade.size, 0),
        quoteVolume24h: volume24h,
        updated: new Date().toISOString()
      };
    } catch (error) {
      console.error('Error fetching market stats:', error);
      throw new Error(`Failed to fetch market stats: ${error.message}`);
    }
  }
}

module.exports = SolanaOrderBook;
