# mt5_bridge.py - Enhanced with BTC support
import MetaTrader5 as mt5
import json
import sys
import time
import logging
from datetime import datetime, timedelta

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

class MT5Bridge:
    def __init__(self):
        self.connected = False
        self.account_info = None
        self.initialized = False
        self.symbols = {}
        self.supported_symbols = ['EURUSD', 'GBPUSD', 'USDJPY', 'BTCUSD']
        
    def initialize(self):
        try:
            if not mt5.initialize():
                logger.error("MT5 initialization failed")
                return False
            
            self.initialized = True
            self.connected = True
            logger.info("MT5 initialized successfully")
            
            # Enable symbols
            for symbol in self.supported_symbols:
                mt5.symbol_select(symbol, True)
                logger.info(f"Symbol {symbol} enabled")
            
            symbols = mt5.symbols_get()
            if symbols:
                for symbol in symbols:
                    self.symbols[symbol.name] = {
                        'name': symbol.name,
                        'digits': symbol.digits,
                        'point': symbol.point,
                        'visible': symbol.visible
                    }
            
            logger.info(f"Loaded {len(self.symbols)} symbols")
            return True
            
        except Exception as e:
            logger.error(f"MT5 initialization error: {e}")
            return False

    def login(self, login, password, server):
        try:
            if not self.initialized:
                if not self.initialize():
                    return {"success": False, "error": "MT5 not initialized"}
            
            authorized = mt5.login(login, password, server)
            if authorized:
                self.account_info = mt5.account_info()
                logger.info(f"Logged in: {self.account_info.login}")
                
                info = self.account_info._asdict()
                return {
                    "success": True,
                    "account": {
                        "login": info['login'],
                        "balance": info['balance'],
                        "equity": info['equity'],
                        "margin": info['margin'],
                        "free_margin": info['margin_free'],
                        "profit": info['profit'],
                        "leverage": info['leverage'],
                        "currency": info['currency']
                    }
                }
            else:
                error = mt5.last_error()
                logger.error(f"Login failed: {error}")
                return {"success": False, "error": f"Login failed: {error}"}
                
        except Exception as e:
            logger.error(f"Login error: {e}")
            return {"success": False, "error": str(e)}

    def get_account_info(self):
        try:
            if not self.connected:
                return {"success": False, "error": "MT5 not connected"}
            
            info = mt5.account_info()
            if info:
                return {
                    "success": True,
                    "balance": info.balance,
                    "equity": info.equity,
                    "margin": info.margin,
                    "free_margin": info.margin_free,
                    "profit": info.profit,
                    "leverage": info.leverage,
                    "currency": info.currency,
                    "login": info.login
                }
            return {"success": False, "error": "Could not fetch account info"}
            
        except Exception as e:
            logger.error(f"Get account info error: {e}")
            return {"success": False, "error": str(e)}

    def get_open_positions(self):
        try:
            if not self.connected:
                return {"success": False, "error": "MT5 not connected"}
            
            positions = mt5.positions_get()
            if positions:
                position_list = []
                for p in positions:
                    pos_dict = p._asdict()
                    for key, value in pos_dict.items():
                        if isinstance(value, datetime):
                            pos_dict[key] = value.isoformat()
                    position_list.append(pos_dict)
                
                total_profit = sum(p['profit'] for p in position_list)
                return {
                    "success": True,
                    "positions": position_list,
                    "count": len(position_list),
                    "total_profit": total_profit
                }
            return {"success": True, "positions": [], "count": 0, "total_profit": 0}
            
        except Exception as e:
            logger.error(f"Get positions error: {e}")
            return {"success": False, "error": str(e)}

    def place_order(self, symbol, order_type, volume, price=None, sl=None, tp=None):
        try:
            if not self.connected:
                return {"success": False, "error": "MT5 not connected"}

            symbol_info = mt5.symbol_info(symbol)
            if not symbol_info:
                return {"success": False, "error": f"Symbol {symbol} not found"}
            
            if not symbol_info.visible:
                mt5.symbol_select(symbol, True)
            
            tick = mt5.symbol_info_tick(symbol)
            if not tick:
                return {"success": False, "error": "Could not get price"}
            
            # BTC uses different lot size
            if symbol == 'BTCUSD':
                volume = round(volume, 2)
            else:
                volume = round(volume, 2)
            
            order_type_map = {
                'buy': mt5.ORDER_TYPE_BUY,
                'sell': mt5.ORDER_TYPE_SELL,
                'buy_limit': mt5.ORDER_TYPE_BUY_LIMIT,
                'sell_limit': mt5.ORDER_TYPE_SELL_LIMIT,
                'buy_stop': mt5.ORDER_TYPE_BUY_STOP,
                'sell_stop': mt5.ORDER_TYPE_SELL_STOP
            }
            
            if order_type not in order_type_map:
                return {"success": False, "error": f"Invalid order type: {order_type}"}
            
            if price is None:
                if order_type in ['buy', 'buy_limit', 'buy_stop']:
                    price = tick.ask
                else:
                    price = tick.bid
            
            request = {
                "action": mt5.TRADE_ACTION_DEAL if order_type in ['buy', 'sell'] else mt5.TRADE_ACTION_PENDING,
                "symbol": symbol,
                "volume": float(volume),
                "type": order_type_map[order_type],
                "price": price,
                "deviation": 50,
                "magic": 234567,
                "comment": f"Scalper/BTC {datetime.now().strftime('%H:%M')}",
                "type_time": mt5.ORDER_TIME_GTC,
                "type_filling": mt5.ORDER_FILLING_IOC,
            }

            if sl:
                request["sl"] = float(sl)
            if tp:
                request["tp"] = float(tp)

            result = mt5.order_send(request)
            
            if result.retcode != mt5.TRADE_RETCODE_DONE:
                return {
                    "success": False, 
                    "error": f"Order failed: {result.comment}", 
                    "code": result.retcode
                }
            
            logger.info(f"✅ Order placed: {result.order} - {symbol} {order_type} {volume} lots")
            
            return {
                "success": True,
                "order_id": result.order,
                "volume": result.volume,
                "price": result.price,
                "comment": result.comment,
                "ticket": result.order,
                "sl": sl,
                "tp": tp
            }
            
        except Exception as e:
            logger.error(f"Place order error: {e}")
            return {"success": False, "error": str(e)}

    def close_position(self, position_id):
        try:
            if not self.connected:
                return {"success": False, "error": "MT5 not connected"}

            position = mt5.positions_get(ticket=position_id)
            if not position:
                return {"success": False, "error": f"Position {position_id} not found"}
            
            position = position[0]
            
            request = {
                "action": mt5.TRADE_ACTION_DEAL,
                "symbol": position.symbol,
                "volume": position.volume,
                "type": mt5.ORDER_TYPE_BUY if position.type == 1 else mt5.ORDER_TYPE_SELL,
                "position": position.ticket,
                "price": mt5.symbol_info_tick(position.symbol).bid if position.type == 1 else mt5.symbol_info_tick(position.symbol).ask,
                "deviation": 50,
                "magic": position.magic,
                "comment": f"Close by EA {datetime.now().strftime('%H:%M')}",
                "type_time": mt5.ORDER_TIME_GTC,
                "type_filling": mt5.ORDER_FILLING_IOC,
            }

            result = mt5.order_send(request)
            
            if result.retcode != mt5.TRADE_RETCODE_DONE:
                return {"success": False, "error": f"Close failed: {result.comment}"}
            
            logger.info(f"Position closed: {position_id}")
            return {"success": True, "order_id": result.order, "ticket": result.order}
            
        except Exception as e:
            logger.error(f"Close position error: {e}")
            return {"success": False, "error": str(e)}

    def get_market_data(self, symbol, timeframe='M1', bars=100):
        try:
            if not self.connected:
                return {"success": False, "error": "MT5 not connected"}
            
            timeframe_map = {
                'M1': mt5.TIMEFRAME_M1,
                'M5': mt5.TIMEFRAME_M5,
                'M15': mt5.TIMEFRAME_M15,
                'M30': mt5.TIMEFRAME_M30,
                'H1': mt5.TIMEFRAME_H1,
                'H4': mt5.TIMEFRAME_H4,
                'D1': mt5.TIMEFRAME_D1,
                'W1': mt5.TIMEFRAME_W1,
                'MN1': mt5.TIMEFRAME_MN1
            }
            
            tf = timeframe_map.get(timeframe, mt5.TIMEFRAME_M1)
            
            rates = mt5.copy_rates_from_pos(symbol, tf, 0, int(bars))
            if rates is None or len(rates) == 0:
                return {"success": False, "error": f"Could not get data for {symbol}"}
            
            data = []
            for rate in rates:
                data.append({
                    "time": datetime.fromtimestamp(rate[0]).isoformat(),
                    "open": rate[1],
                    "high": rate[2],
                    "low": rate[3],
                    "close": rate[4],
                    "volume": rate[5]
                })
            
            return {
                "success": True, 
                "data": data,
                "symbol": symbol,
                "timeframe": timeframe,
                "count": len(data)
            }
            
        except Exception as e:
            logger.error(f"Get market data error: {e}")
            return {"success": False, "error": str(e)}

    def shutdown(self):
        try:
            if self.connected:
                mt5.shutdown()
                self.connected = False
                self.initialized = False
                logger.info("MT5 shutdown")
                return {"success": True}
            return {"success": False, "error": "Already disconnected"}
            
        except Exception as e:
            logger.error(f"Shutdown error: {e}")
            return {"success": False, "error": str(e)}

# ============ COMMAND LINE INTERFACE ============
def main():
    bridge = MT5Bridge()
    
    if not bridge.initialize():
        logger.error("Failed to initialize MT5")
        sys.exit(1)
    
    logger.info("Bridge ready - Scalper + BTC mode")
    print(json.dumps({"status": "ready", "message": "MT5 bridge initialized"}))
    
    while True:
        try:
            line = sys.stdin.readline()
            if not line:
                break
            
            line = line.strip()
            if not line:
                continue
            
            try:
                command = json.loads(line)
                method = command.get('method')
                params = command.get('params', {})
                request_id = command.get('id')
                
                if not method:
                    continue
                
                if hasattr(bridge, method):
                    result = getattr(bridge, method)(**params)
                    response = {
                        "id": request_id,
                        "success": True,
                        "result": result
                    }
                else:
                    response = {
                        "id": request_id,
                        "success": False,
                        "error": f"Method {method} not found"
                    }
                
                print(json.dumps(response))
                sys.stdout.flush()
                
            except json.JSONDecodeError as e:
                logger.error(f"JSON decode error: {e}")
                continue
                
        except KeyboardInterrupt:
            break
        except Exception as e:
            logger.error(f"Main loop error: {e}")
            continue
    
    bridge.shutdown()

if __name__ == "__main__":
    main()
