const binanceService = require('./binance');
const telegramService = require('./telegram');
const config = require('../config/config');

class MonitorService {
    constructor() {
        this.previousData = new Map();
        this.VOLUME_THRESHOLD = parseFloat(config.monitor.volumeThreshold);
        this.MIN_PRICE_CHANGE = parseFloat(config.monitor.minPriceChange);
        this.MIN_QUOTE_VOLUME = parseFloat(config.monitor.minQuoteVolume);
        this.isChecking = false;
        this.recentSymbols = [];

        console.log('监控参数:', {
            成交量阈值: this.VOLUME_THRESHOLD + '倍',
            价格变化: this.MIN_PRICE_CHANGE + '%',
            最小成交额: this.MIN_QUOTE_VOLUME + ' USDT'
        });
    }

    displayRecentSymbols() {
        if (this.recentSymbols.length > 0) {
            console.log('\n最近3个币种数据:');
            this.recentSymbols.forEach((data, index) => {
                console.log(`${index + 1}. ${data.symbol}`);
                console.log(`   当前5分钟交易量: ${data.volume.toFixed(2)} 个`);
                console.log(`   前30分钟平均交易量: ${data.avgHistoricalVolume.toFixed(2)} 个`);
                console.log(`   交易量变化倍数: ${(data.volume / data.avgHistoricalVolume).toFixed(2)}倍`);
                console.log(`   当前价格: ${data.lastPrice}`);
                console.log(`   5分钟成交额: ${data.quoteVolume.toFixed(2)} USDT`);
            });
            console.log('------------------------');
        }
    }

    async start() {
        console.log('开始监控币安合约市场...');
        console.log(`最低成交额限制: ${this.MIN_QUOTE_VOLUME} USDT`);
        
        try {
            // 首次运行获取基准数据
            const initialData = await binanceService.getAllSymbolData();
            initialData.forEach(item => {
                // 只保存必要的数据
                this.previousData.set(item.symbol, {
                    lastPrice: parseFloat(item.lastPrice),
                    time: item.time
                });
            });
            console.log(`初始化完成，正在监控 ${initialData.length} 个交易对`);

            this.scheduleNextCheck();
        } catch (error) {
            console.error('初始化失败:', error);
            process.exit(1);
        }
    }

    getNextInterval() {
        const now = new Date();
        
        // 计算下一个5分钟的整点时间
        const nextTime = new Date(now);
        nextTime.setMinutes(Math.ceil(now.getMinutes() / 5) * 5);
        nextTime.setSeconds(3);  // 固定在第3秒
        nextTime.setMilliseconds(0);
        
        // 如果计算出的时间已经过去，就加5分钟
        if (nextTime <= now) {
            nextTime.setMinutes(nextTime.getMinutes() + 5);
        }
        
        // 返回到下一个检查点的毫秒数
        return nextTime.getTime() - now.getTime();
    }

    scheduleNextCheck() {
        const waitTime = this.getNextInterval();
        const nextCheckTime = new Date(Date.now() + waitTime);
        console.log(`下次检查时间: ${nextCheckTime.toLocaleString()}`);
        
        setTimeout(async () => {
            if (!this.isChecking) {
                try {
                    await this.checkSymbols();
                } catch (error) {
                    console.error('检查市场时出错:', error);
                }
            }
            this.scheduleNextCheck();
        }, waitTime);
    }

    validateData(data) {
        return data && 
               typeof data.volume === 'number' && 
               typeof data.lastPrice === 'number' &&
               typeof data.avgHistoricalVolume === 'number' &&
               data.volume > 0 &&
               data.lastPrice > 0 &&
               data.avgHistoricalVolume > 0;
    }

    async checkSymbols() {
        if (this.isChecking) {
            console.log('上一次检查还未完成，跳过本次检查');
            return;
        }

        this.isChecking = true;
        console.log('\n开始新一轮市场检查...');
        
        try {
            const currentData = await binanceService.getAllSymbolData();
            // 过滤无效数据
            const validData = currentData.filter(data => this.validateData(data));
            console.log(`本轮获取到 ${currentData.length} 个交易对，有效数据 ${validData.length} 个`);
            
            // 深拷贝最近3个币种数据，避免引用
            this.recentSymbols = validData.slice(0, 3).map(data => ({
                symbol: data.symbol,
                volume: data.volume,
                avgHistoricalVolume: data.avgHistoricalVolume,
                lastPrice: data.lastPrice,
                quoteVolume: data.quoteVolume
            }));
            
            let alertCount = 0;
            for (const data of validData) {
                if (!data) continue;

                const volumeChange = data.volume / data.avgHistoricalVolume;
                
                if (volumeChange >= this.VOLUME_THRESHOLD && 
                    data.quoteVolume >= this.MIN_QUOTE_VOLUME) {
                    
                    const previousPrice = this.previousData.get(data.symbol)?.lastPrice;
                    if (!previousPrice) {
                        // 只保存必要的数据
                        this.previousData.set(data.symbol, {
                            lastPrice: data.lastPrice,
                            time: data.time
                        });
                        continue;
                    }

                    const priceChange = ((data.lastPrice - previousPrice) / previousPrice) * 100;

                    if (priceChange >= this.MIN_PRICE_CHANGE) {
                        console.log('\n发现异常交易对:');
                        console.log(`币种: ${data.symbol}`);
                        console.log(`时间: ${data.time}`);
                        console.log(`当前交易量: ${data.volume.toFixed(2)} 个`);
                        console.log(`平均交易量: ${data.avgHistoricalVolume.toFixed(2)} 个`);
                        console.log(`交易量变化: ${volumeChange.toFixed(2)}倍`);
                        console.log(`价格变化: ${priceChange.toFixed(2)}%`);
                        console.log(`成交额: ${data.quoteVolume.toFixed(2)} USDT`);
                        console.log('------------------------');

                        await telegramService.sendAlert(
                            data.symbol,
                            data.lastPrice.toFixed(4),
                            priceChange.toFixed(2),
                            volumeChange.toFixed(2),
                            data.quoteVolume.toFixed(2)
                        );
                        alertCount++;
                    }
                }

                // 只保存必要的数据
                this.previousData.set(data.symbol, {
                    lastPrice: data.lastPrice,
                    time: data.time
                });
            }
            
            // 每次检查后都清理历史数据
            this.cleanupHistory();
            
            console.log(`\n本轮检查完成`);
            console.log(`发送提醒: ${alertCount} 个`);
            this.displayRecentSymbols();
            
        } catch (error) {
            console.error('检查交易对时发生错误:', error);
        } finally {
            this.isChecking = false;
        }
    }

    cleanupHistory() {
        // 主要依赖时间来清理，而不是数量限制
        const oneHourAgo = Date.now() - 3600000;
        for (const [symbol, data] of this.previousData.entries()) {
            if (data.time < oneHourAgo) {
                this.previousData.delete(symbol);
            }
        }
    }
}

module.exports = new MonitorService();