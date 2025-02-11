import { getBinanceData } from '../services/binance.js';
import { sendTelegramMessage } from '../services/telegram.js';

// 用于存储上一次的数据
let lastDataMap = new Map();

// 修改为 Node.js API 格式
module.exports = async (req, res) => {
    try {
        // 基本的安全检查
        const authToken = req.headers['x-auth-token'];
        if (authToken !== process.env.AUTH_TOKEN) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        // 获取币安数据
        const currentData = await getBinanceData();
        
        // 分析数据并发送告警
        for (const symbol of currentData.keys()) {
            const current = currentData.get(symbol);
            const last = lastDataMap.get(symbol);
            
            if (last) {
                // 检查价格是否上涨
                const priceChange = (current.price - last.price) / last.price;
                
                // 检查成交量是否暴涨(2倍)
                const volumeRatio = current.volume / last.volume;
                
                if (priceChange > 0 && volumeRatio >= 2) {
                    // 发送Telegram告警
                    const message = `🚨 交易量暴涨提醒\n` +
                        `币种：${symbol}\n` +
                        `当前价格：${current.price}\n` +
                        `价格变化：+${(priceChange * 100).toFixed(2)}%\n` +
                        `成交量变化：${volumeRatio.toFixed(2)}倍`;
                    
                    await sendTelegramMessage(message);
                }
            }
        }
        
        // 更新lastDataMap
        lastDataMap = new Map(currentData);
        
        res.status(200).json({ status: 'success' });
    } catch (error) {
        console.error('Monitor error:', error);
        res.status(500).json({ error: error.message });
    }
} 