import { createBot } from 'mineflayer';
import pkg from 'mineflayer-pathfinder';
const pathfinder = pkg.pathfinder;
const goals = pkg.goals;
import { createLogger, format, transports } from 'winston';
import express from 'express';
import { fileURLToPath } from 'url'; // Đã sửa lỗi cú pháp tại đây
import path from 'path';
import fs from 'fs';
import { performance } from 'perf_hooks';
import cors from 'cors'; // Import thư viện CORS

// =================================================================================================
// Cấu hình Logger (Winston) - Đã cải thiện với icon, màu sắc và định dạng thoáng
// =================================================================================================

// Mảng để lưu trữ các log gần đây cho Web Dashboard
const recentLogs = [];
const MAX_LOGS = 100; // Giới hạn số lượng log được lưu

const logger = createLogger({
    level: 'info',
    format: format.combine(
        format.timestamp({
            format: 'YYYY-MM-DD HH:mm:ss'
        }),
        format.printf(info => {
            let emoji = '';
            switch (info.level.toUpperCase()) {
                case 'INFO':
                    emoji = '💬';
                    break;
                case 'WARN':
                    emoji = '⚠️';
                    break;
                case 'ERROR':
                    emoji = '❌';
                    break;
                default:
                    emoji = '📝'; // Emoji mặc định cho các cấp độ log khác
                    break;
            }
            // Làm sạch tin nhắn: loại bỏ các ký tự định dạng Markdown như ** và __
            const cleanMessage = info.message.replace(/\*\*/g, '').replace(/__/g, '').trim();

            // Đẩy log vào mảng recentLogs cho Web Dashboard
            recentLogs.push({
                timestamp: info.timestamp,
                level: info.level,
                emoji: emoji,
                message: cleanMessage
            });
            // Giới hạn kích thước mảng để tránh tràn bộ nhớ
            if (recentLogs.length > MAX_LOGS) {
                recentLogs.shift(); // Xóa log cũ nhất
            }

            // Trả về chuỗi log đã định dạng cho console
            return `${info.timestamp} ${emoji} ${info.level.toUpperCase()}: ${cleanMessage}`;
        })
    ),
    transports: [
        new transports.Console({
            format: format.combine(
                format.colorize({
                    colors: {
                        info: 'green',
                        warn: 'yellow',
                        error: 'red',
                    }
                }),
                format.printf(info => info.message) // Winston's colorize applies to the whole string from the main format
            )
        }),
    ]
});


// =================================================================================================
// Cấu hình cơ bản (Đọc từ config.json)
// =================================================================================================
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const configPath = path.join(__dirname, 'config.json');
const botStatusFilePath = path.join(__dirname, 'bot_status.json');

let config;
try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    logger.info('⚙️ CẤU HÌNH: Đã tải cấu hình từ config.json.');

    if (config.server.host === "your_server_ip_or_hostname") {
        logger.error('❌ CẤU HÌNH LỖI: Địa chỉ máy chủ (host) trong config.json vẫn là "your_server_ip_or_hostname".');
        logger.error('⚠️ Vui lòng sửa đổi nó thành địa chỉ IP hoặc hostname thực của máy chủ Minecraft bạn muốn kết nối.');
        process.exit(1); // Thoát ứng dụng nếu cấu hình server không hợp lệ
    } else {
        logger.info(`🌐 CẤU HÌNH SERVER: Host: ${config.server.host}, Port: ${config.server.port}, Version: ${config.server.version}`);
        logger.info(`🤖 CẤU HÌNH BOT: Username (base): ${config.bot.baseUsername}, Auth: ${config.bot.auth}`);
    }

} catch (error) {
    logger.error(`❌ LỖI CONFIG: Lỗi khi tải cấu hình từ config.json: ${error.message}`);
    logger.error('⚠️ Vui lòng đảm bảo file config.json tồn tại và đúng định dạng JSON.');
    process.exit(1); // Thoát ứng dụng nếu file config bị lỗi
}

// =================================================================================================
// Biến trạng thái Bot và Quản lý File trạng thái
// =================================================================================================
let bot;
let botStartTime = null;
let currentUsername = config.bot.baseUsername;
let isAttemptingReconnect = false;
let reconnectAttemptCount = 0;
let afkIntervalId = null; // Để lưu ID của setInterval AFK
let autoChatIntervalId = null; // Để lưu ID của setInterval AutoChat
let isManuallyStopped = false; // Cờ mới để theo dõi việc dừng bot thủ công
let reconnectTimeoutId = null; // Biến để lưu ID của setTimeout cho reconnect

let botState = {
    username: config.bot.baseUsername,
    lastKick: null
};

const saveBotState = () => {
    try {
        fs.writeFileSync(botStatusFilePath, JSON.stringify(botState, null, 2), 'utf8');
        logger.info('💾 TRẠNG THÁI: Đã lưu trạng thái bot.');
    } catch (error) {
        logger.error(`❌ LỖI TRẠNG THÁI: Lỗi khi lưu trạng thái bot: ${error.message}`);
    }
};

const loadBotState = () => {
    try {
        if (fs.existsSync(botStatusFilePath)) {
            const loadedState = JSON.parse(fs.readFileSync(botStatusFilePath, 'utf8'));
            botState = { ...botState, ...loadedState };
            currentUsername = botState.username; // Cập nhật tên người dùng hiện tại từ trạng thái đã lưu
            logger.info(`✅ TRẠNG THÁI: Đã tải trạng thái bot. Sử dụng tên người dùng: ${currentUsername}`);
            if (botState.lastKick) {
                const reasonToLog = typeof botState.lastKick.reason === 'object' ? JSON.stringify(botState.lastKick.reason) : botState.lastKick.reason;
                logger.warn(`⚠️ TRẠNG THÁI: Lần bị kick gần nhất: Server: ${botState.lastKick.server}, User: ${botState.lastKick.username}, Lý do: "${reasonToLog}"`);
            }
        } else {
            logger.info('🆕 TRẠNG THÁI: Không tìm thấy tệp trạng thái bot, sử dụng cấu hình mặc định.');
            saveBotState(); // Lưu trạng thái mặc định mới
        }
    } catch (error) {
        logger.error(`❌ LỖI TRẠNG THÁI: Lỗi khi tải trạng thái bot: ${error.message}. Sử dụng cấu hình mặc định.`);
        saveBotState(); // Cố gắng lưu trạng thái mặc định nếu có lỗi
    }
};

loadBotState(); // Tải trạng thái bot khi ứng dụng khởi động

// =================================================================================================
// Quản lý tên người dùng ngẫu nhiên
// =================================================================================================
const generateRandomUsername = (length) => {
    const characters = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    const charactersLength = characters.length;
    for (let i = 0; i < length; i++) {
        result += characters.charAt(Math.floor(Math.random() * charactersLength));
    }
    const newUsername = `${config.bot.baseUsername}-${result}`;
    logger.info(`👤 TÊN NGƯỜI DÙNG: Tạo tên ngẫu nhiên mới: ${newUsername}`);
    return newUsername;
};

// =================================================================================================
// Hàm quản lý việc lên lịch kết nối lại
// =================================================================================================
function scheduleReconnect(delay, reason) {
    // Nếu đã có một bộ đếm thời gian kết nối lại đang chờ xử lý, hãy hủy nó
    if (reconnectTimeoutId) {
        clearTimeout(reconnectTimeoutId);
        reconnectTimeoutId = null;
    }

    // Đảm bảo đối tượng bot cũ được dọn dẹp hoàn toàn trước khi lên lịch kết nối mới
    if (bot) {
        bot.removeAllListeners(); // Xóa tất cả các listener để tránh rò rỉ bộ nhớ
        bot = null; // Hủy bỏ đối tượng bot cũ
    }
    isAttemptingReconnect = false; // Reset cờ này để cho phép kết nối lại

    reconnectAttemptCount++;
    logger.info(`🔄 KẾT NỐI LẠI: Đang cố gắng kết nối lại sau ${delay / 1000} giây do ${reason}... (Lần thử tiếp theo: ${reconnectAttemptCount})`);
    reconnectTimeoutId = setTimeout(createMinecraftBot, delay);
}


// =================================================================================================
// Khởi tạo và Quản lý Bot
// =================================================================================================
function createMinecraftBot() {
    // Xóa bất kỳ bộ đếm thời gian kết nối lại nào đang chờ xử lý
    if (reconnectTimeoutId) {
        clearTimeout(reconnectTimeoutId);
        reconnectTimeoutId = null;
    }

    // Nếu bot đã tồn tại và online, không tạo mới
    if (bot && bot.isOnline) {
        logger.warn('⚠️ KHỞI ĐỘNG BOT: Bot đã trực tuyến. Không cần khởi động lại.');
        return;
    }
    // Nếu đang trong quá trình kết nối lại, chờ đợi
    if (isAttemptingReconnect) {
        logger.warn('⚠️ KHỞI ĐỘNG BOT: Bot đang trong quá trình kết nối lại. Chờ đợi.');
        return;
    }

    isAttemptingReconnect = true; // Đặt cờ đang cố gắng kết nối lại
    isManuallyStopped = false; // Reset cờ này khi khởi tạo kết nối mới
    reconnectAttemptCount++; // Tăng số lần thử kết nối

    // Mineflayer sẽ tự động dò tìm phiên bản nếu 'version' được đặt là false
    // Điều này giúp bot kết nối được với nhiều phiên bản server Java khác nhau
    logger.info(`🔗 KẾT NỐI: Đang cố gắng kết nối tới ${config.server.host}:${config.server.port} (lần thử: ${reconnectAttemptCount}) với tên người dùng: ${currentUsername} (dò tìm phiên bản tự động, auth: ${config.bot.auth})`);

    bot = createBot({
        host: config.server.host,
        port: config.server.port,
        username: currentUsername,
        password: config.bot.password || undefined, // Mật khẩu có thể không tồn tại
        auth: config.bot.auth,
        version: false, // Đặt false để Mineflayer tự động dò tìm phiên bản server Java
        hideErrors: false // Hiển thị lỗi Mineflayer để dễ debug
    });

    // Tải plugin pathfinder
    bot.loadPlugin(pathfinder);

    // =================================================================================================
    // Xử lý sự kiện Bot
    // =================================================================================================
    bot.on('spawn', () => {
        logger.info(`✅ BOT TRỰC TUYẾN: Đã kết nối thành công với server ${config.server.host} (phiên bản: ${bot.version})!`);
        botStartTime = performance.now(); // Ghi lại thời gian bot online
        isAttemptingReconnect = false; // Reset cờ đang cố gắng kết nối
        reconnectAttemptCount = 0; // Reset số lần thử kết nối
        botState.username = currentUsername; // Cập nhật tên người dùng trong trạng thái bot
        saveBotState(); // Lưu trạng thái bot

        // Xóa các interval AFK/AutoChat hiện có để tránh trùng lặp
        if (afkIntervalId) clearInterval(afkIntervalId);
        if (autoChatIntervalId) clearInterval(autoChatIntervalId);

        // Kích hoạt tính năng Anti-AFK nếu được bật trong cấu hình
        if (config.features.antiAfk.enabled) {
            logger.info('🚶 AFK: Tính năng Anti-AFK đã được bật.');
            afkIntervalId = setInterval(async () => { // Sử dụng async để có thể dùng await bên trong
                if (bot.isOnline) {
                    const actions = config.features.antiAfk.actions;
                    const possibleActions = Object.keys(actions).filter(action => actions[action]); // Lọc các hành động được bật

                    if (possibleActions.length > 0) {
                        const randomAction = possibleActions[Math.floor(Math.random() * possibleActions.length)];
                        logger.info(`🏃 AFK HÀNH ĐỘNG: Đang thực hiện hành động AFK: ${randomAction}`);

                        try { // Bắt lỗi riêng cho từng hành động AFK
                            switch (randomAction) {
                                case 'jump':
                                    bot.setControlState('jump', true);
                                    await bot.waitForTicks(5); // Chờ một chút để bot nhảy
                                    bot.setControlState('jump', false);
                                    break;
                                case 'sneak':
                                    // Chuyển đổi trạng thái lén lút
                                    bot.setControlState('sneak', !bot.getControlState('sneak'));
                                    break;
                                case 'lookAround':
                                    // Nhìn ngẫu nhiên xung quanh
                                    await bot.look(Math.random() * Math.PI * 2, Math.random() * Math.PI - (Math.PI / 2), true);
                                    break;
                                case 'swingArm':
                                    // Vung tay
                                    bot.swingArm();
                                    break;
                                case 'walkRandomly':
                                    // Đi bộ ngẫu nhiên theo một hướng
                                    const walkDirections = ['forward', 'back', 'left', 'right'];
                                    const randomWalkDirection = walkDirections[Math.floor(Math.random() * walkDirections.length)];
                                    bot.setControlState(randomWalkDirection, true);
                                    await bot.waitForTicks(Math.floor(Math.random() * 20) + 10); // Đi bộ 0.5 - 1 giây
                                    bot.setControlState(randomWalkDirection, false);
                                    break;
                                case 'sprintForward':
                                    // Chạy về phía trước
                                    bot.setControlState('forward', true);
                                    bot.setControlState('sprint', true);
                                    await bot.waitForTicks(Math.random() * 40 + 20); // Chạy 1 - 2 giây
                                    bot.setControlState('forward', false);
                                    bot.setControlState('sprint', false);
                                    break;
                                case 'toggleWalk':
                                    // Chuyển đổi đi bộ tiến/lùi
                                    const walkToggleDirections = ['forward', 'back'];
                                    const toggleDirection = walkToggleDirections[Math.floor(Math.random() * walkToggleDirections.length)];
                                    const walkDurationTicks = Math.floor(Math.random() * 40) + 10; // 0.5s to 2.5s
                                    bot.setControlState(toggleDirection, true);
                                    await bot.waitForTicks(walkDurationTicks);
                                    bot.setControlState(toggleDirection, false);
                                    break;
                                case 'mineBlockRandomly':
                                    // Tìm và đào một khối ngẫu nhiên gần đó
                                    const diggableBlock = bot.findBlock({
                                        matching: (block) => bot.canDigBlock(block) && !bot.registry.blocksById[block.type].name.includes('air') && bot.entity.position.distanceTo(block.position) < 6,
                                        maxDistance: 6,
                                        count: 1
                                    });
                                    if (diggableBlock) {
                                        logger.info(`⛏️ AFK HÀNH ĐỘNG: Đang đào khối ${diggableBlock.name} tại ${diggableBlock.position.x},${diggableBlock.position.y},${diggableBlock.position.z}`);
                                        await bot.dig(diggableBlock);
                                        logger.info(`⛏️ AFK HÀNH ĐỘNG: Đã đào xong khối ${diggableBlock.name}.`);
                                    } else {
                                        logger.warn('⚠️ AFK HÀNH ĐỘNG: Không tìm thấy khối nào để đào gần đó hoặc không thể đào.');
                                    }
                                    break;
                                case 'placeBlockRandomly':
                                    // Tìm và đặt một khối ngẫu nhiên từ hành trang
                                    const blockToPlace = bot.inventory.items().find(item => item.name.includes('dirt') || item.name.includes('cobblestone') || item.name.includes('planks'));
                                    if (blockToPlace) {
                                        const possiblePositions = [
                                            bot.entity.position.offset(0, -1, 0).floored(), // Dưới chân
                                            bot.entity.position.offset(0, 0, 1).floored(), // Phía trước
                                            bot.entity.position.offset(1, 0, 0).floored(), // Phải
                                            bot.entity.position.offset(0, 0, -1).floored(), // Sau
                                            bot.entity.position.offset(-1, 0, 0).floored() // Trái
                                        ];
                                        let targetPosition = null;
                                        let referenceBlockForPlace = null;

                                        for(const pos of possiblePositions) {
                                            const blockAtPos = bot.blockAt(pos);
                                            const blockBelow = bot.blockAt(pos.offset(0, -1, 0));
                                            // Kiểm tra xem vị trí có trống và có khối hỗ trợ bên dưới không
                                            if (blockAtPos && blockAtPos.name === 'air' && blockBelow && blockBelow.name !== 'air' && bot.entity.position.distanceTo(pos) < 5) {
                                                targetPosition = pos;
                                                referenceBlockForPlace = blockBelow;
                                                break;
                                            }
                                        }

                                        if (targetPosition && referenceBlockForPlace) {
                                            logger.info(`🧱 AFK HÀNH ĐỘNG: Đang đặt khối ${blockToPlace.name} tại ${targetPosition.x},${targetPosition.y},${targetPosition.z}`);
                                            await bot.equip(blockToPlace, 'hand');
                                            // Đặt khối lên khối tham chiếu
                                            await bot.placeBlock(referenceBlockForPlace, new pkg.Vec3(0, 1, 0));
                                            logger.info(`🧱 AFK HÀNH ĐỘNG: Đã đặt khối ${blockToPlace.name}.`);
                                        } else {
                                            logger.warn('⚠️ AFK HÀNH ĐỘNG: Không tìm thấy vị trí phù hợp để đặt khối hoặc vị trí đã có khối.');
                                        }
                                    } else {
                                        logger.warn('⚠️ AFK HÀNH ĐỘNG: Không có khối nào để đặt trong hành trang (cần Dirt, Cobblestone hoặc Planks).');
                                    }
                                    break;
                                case 'useItem':
                                    // Sử dụng vật phẩm có thể ăn/uống
                                    const usableItem = bot.inventory.items().find(item => item.name.includes('food') || item.name.includes('potion'));
                                    if (usableItem) {
                                        logger.info(`🍎 AFK HÀNH ĐỘNG: Đang sử dụng vật phẩm ${usableItem.name}`);
                                        await bot.equip(usableItem, 'hand');
                                        await bot.consume();
                                        logger.info(`🍎 AFK HÀNG ĐỘNG: Đã sử dụng vật phẩm.`);
                                    } else {
                                        logger.warn('⚠️ AFK HÀNH ĐỘNG: Không tìm thấy vật phẩm có thể sử dụng (thức ăn/thuốc) trong hành trang.');
                                    }
                                    break;
                                case 'switchHotbar':
                                    // Đổi slot hotbar ngẫu nhiên
                                    const currentSlot = bot.inventory.selectedHotbarFrame;
                                    let newSlot = Math.floor(Math.random() * 9);
                                    if (newSlot === currentSlot) {
                                        newSlot = (newSlot + 1) % 9; // Đảm bảo đổi sang slot khác
                                    }
                                    logger.info(`🔄 AFK HÀNH ĐỘNG: Đang đổi slot Hotbar từ ${currentSlot + 1} sang ${newSlot + 1}`);
                                    bot.setQuickBarSlot(newSlot);
                                    break;
                                case 'dropItem':
                                    // Thả vật phẩm an toàn (không phải công cụ/giáp)
                                    const itemsInInventory = bot.inventory.items();
                                    const safeItemsToDrop = itemsInInventory.filter(item =>
                                        !item.name.includes('pickaxe') &&
                                        !item.name.includes('sword') &&
                                        !item.name.includes('armor') &&
                                        item.count > 1 // Chỉ thả nếu có nhiều hơn 1 stack (để không thả hết)
                                    );

                                    if (safeItemsToDrop.length > 0) {
                                        const itemToDrop = safeItemsToDrop[Math.floor(Math.random() * safeItemsToDrop.length)];
                                        logger.info(`🗑️ AFK HÀNH ĐỘNG: Đang thả ${itemToDrop.count} của vật phẩm ${itemToDrop.name}`);
                                        await bot.drop(itemToDrop.type, itemToDrop.metadata, itemToDrop.count);
                                        logger.info(`🗑️️ AFK HÀNH ĐỘNG: Đã thả vật phẩm.`);
                                    } else {
                                        logger.warn('⚠️ AFK HÀNH ĐỘNG: Không có vật phẩm an toàn để thả trong hành trang (hoặc chỉ có 1 stack).');
                                    }
                                    break;
                                case 'interactWithEntity':
                                    // Tương tác (nhìn) vào thực thể gần nhất
                                    const entity = bot.nearestEntity();
                                    if (entity && (entity.type === 'player' || entity.type === 'mob')) {
                                        logger.info(`👀 AFK HÀNH ĐỘNG: Đang nhìn vào thực thể ${entity.name || entity.type} (${entity.position.toFixed(2)})`);
                                        await bot.lookAt(entity.position.offset(0, entity.height, 0), true);
                                    } else {
                                        logger.warn('⚠️ AFK HÀNH ĐỘNG: Không tìm thấy thực thể (người chơi/mob) nào gần đó để tương tác.');
                                    }
                                    break;
                                case 'openContainer':
                                    // Mở rương/lò nung/bàn chế tạo ngẫu nhiên
                                    const containerBlock = bot.findBlock({
                                        matching: (block) => block.name.includes('chest') || block.name.includes('furnace') || block.name.includes('crafting_table'),
                                        maxDistance: 4,
                                        count: 1
                                    });
                                    if (containerBlock) {
                                        logger.info(`📦 AFK HÀNH ĐỘNG: Đang mở container ${containerBlock.name} tại ${containerBlock.position.x},${containerBlock.position.y},${containerBlock.position.z}`);
                                        const window = await bot.openContainer(containerBlock);
                                        logger.info(`📦 AFK HÀNH ĐỘNG: Đã mở container. Đóng sau 2 giây.`);
                                        await bot.waitForTicks(40); // Chờ 2 giây (20 ticks = 1 giây)
                                        await window.close();
                                        logger.info(`🔒 AFK HÀNH ĐỘNG: Đã đóng container.`);
                                    } else {
                                        logger.warn('⚠️ AFK HÀNH ĐỘNG: Không tìm thấy rương, lò nung hoặc bàn chế tạo gần đó.');
                                    }
                                    break;
                                default:
                                    logger.warn(`⚠️ AFK HÀNH ĐỘNG: Hành động không xác định: ${randomAction}`);
                                    break;
                            }
                        } catch (actionError) {
                            logger.error(`❌ AFK HÀNH ĐỘNG: Lỗi khi thực hiện hành động ${randomAction}: ${actionError.message}`);
                        }

                    } else {
                        logger.warn('⚠️ AFK: Tính năng Anti-AFK được bật nhưng không có hành động nào được chọn trong config.json.');
                    }
                }
            }, Math.random() * (config.features.antiAfk.maxInterval - config.features.antiAfk.minInterval) + config.features.antiAfk.minInterval);
        } else {
            logger.info('😴 AFK: Tính năng Anti-AFK đã bị tắt.');
        }

        // Kích hoạt tính năng Auto-Chat nếu được bật
        if (config.features.autoChat.enabled) {
            logger.info('💬 CHAT: Tính năng Auto-Chat đã được bật.');
            autoChatIntervalId = setInterval(() => {
                if (bot.isOnline && config.features.autoChat.messages.length > 0) {
                    const message = config.features.autoChat.messages[Math.floor(Math.random() * config.features.autoChat.messages.length)];
                    bot.chat(message);
                    logger.info(`🗣️ CHAT TỰ ĐỘNG: Gửi: "${message}"`);
                } else if (bot.isOnline && config.features.autoChat.messages.length === 0) {
                    logger.warn('⚠️ CHAT: Tính năng Auto-Chat được bật nhưng không có tin nhắn nào trong danh sách.');
                }
            }, config.features.autoChat.interval);
        } else {
            logger.info('🚫 CHAT: Tính năng Auto-Chat đã bị tắt.');
        }
    });

    // Xử lý khi bot bị kick khỏi server
    bot.on('kicked', (reason, loggedIn) => {
        const displayReason = typeof reason === 'object' ? JSON.stringify(reason) : reason; // Đảm bảo lý do là chuỗi
        logger.error(`💥 BOT ĐÃ BỊ KICK! Server: ${config.server.host}, Lý do: "${displayReason}"`);
        logger.warn(`ℹ️ Thông tin đăng nhập hợp lệ: ${loggedIn ? 'Có' : 'Không'}`);

        // Lưu thông tin kick vào trạng thái bot
        botState.lastKick = {
            timestamp: new Date().toISOString(),
            server: config.server.host,
            username: currentUsername,
            reason: displayReason // Lưu lý do đã được chuyển đổi thành chuỗi
        };
        saveBotState();

        // Xóa các interval AFK/AutoChat khi bị kick
        if (afkIntervalId) clearInterval(afkIntervalId);
        if (autoChatIntervalId) clearInterval(autoChatIntervalId);

        // Thay đổi tên người dùng ngẫu nhiên nếu tính năng được bật
        if (config.features.randomUsernameOnKick.enabled) {
            currentUsername = generateRandomUsername(config.features.randomUsernameOnKick.length);
            botState.username = currentUsername; // Cập nhật tên người dùng mới vào trạng thái bot
            logger.info(`🔄 TÊN NGƯỜI DÙNG: Thay đổi tên người dùng thành ngẫu nhiên: ${currentUsername}`);
        }

        // Lên lịch kết nối lại thông qua hàm scheduleReconnect
        scheduleReconnect(config.features.autoReconnect.kickDelay, 'bị kick');
    });

    // Xử lý khi kết nối bot bị ngắt (không phải do kick)
    bot.on('end', (reason) => {
        logger.error(`💔 BOT ĐÃ NGẮT KẾT NỐI: Lý do: "${reason}"`);
        // Xóa các interval AFK/AutoChat khi kết nối bị ngắt
        if (afkIntervalId) clearInterval(afkIntervalId);
        if (autoChatIntervalId) clearInterval(autoChatIntervalId);

        // Chỉ lên lịch kết nối lại nếu không bị dừng thủ công VÀ không có kết nối lại nào đang chờ xử lý
        // (Trường hợp kicked sẽ gọi scheduleReconnect trước, nên end sẽ không gọi lại)
        if (!isManuallyStopped && !reconnectTimeoutId) {
            scheduleReconnect(config.features.autoReconnect.delay, 'ngắt kết nối');
        } else if (isManuallyStopped) {
            logger.info('🚫 KẾT NỐI LẠI: Bot đã được dừng thủ công, không tự động kết nối lại.');
            // Đảm bảo bot cũ được hủy bỏ ngay cả khi dừng thủ công
            if (bot) {
                bot.removeAllListeners();
                bot = null;
            }
            isAttemptingReconnect = false;
        } else {
            logger.info('ℹ️ KẾT NỐI LẠI: Đã có yêu cầu kết nối lại đang chờ xử lý từ sự kiện khác.');
        }
    });

    // Xử lý lỗi chung của bot
    bot.on('error', (err) => {
        logger.error(`🐛 LỖI BOT CHUNG: ${err.message}`);
        if (err.message.includes('AuthError') || err.message.includes('Login refused')) {
            logger.error('🔐 LỖI ĐĂNG NHẬP: Có vẻ như tài khoản hoặc phương thức Auth không hợp lệ.');
            if (config.bot.auth === 'online') {
                logger.error('⚠️ Kiểm tra lại tài khoản và mật khẩu trong config.json.');
            } else if (config.bot.auth === 'offline') {
                logger.error('⚠️ Kiểm tra xem server có cho phép chế độ offline (cracked) không.');
            }
        } else if (err.message.includes('Failed to connect') || err.message.includes('ETIMEDOUT') || err.message.includes('ECONNREFUSED') || err.message.includes('ENOTFOUND')) {
            logger.error(`📡 LỖI KẾT NỐI MẠNG: Không thể kết nối tới server ${config.server.host}:${config.server.port}.`);
            logger.error(`⚠️ Kiểm tra lại IP/Port, đảm bảo server đang hoạt động và không có tường lửa chặn kết nối.`);
        } else {
            logger.error(`❓ LỖI KHÁC: Đã xảy ra lỗi không xác định. Vui lòng kiểm tra log để biết thêm chi tiết.`);
        }

        // Xóa các interval khi có lỗi có thể dẫn đến reconnect
        if (afkIntervalId) clearInterval(afkIntervalId);
        if (autoChatIntervalId) clearInterval(autoChatIntervalId);

        // Chỉ lên lịch kết nối lại nếu không bị dừng thủ công VÀ không có kết nối lại nào đang chờ xử lý
        if (!isManuallyStopped && !reconnectTimeoutId) { 
            scheduleReconnect(config.features.autoReconnect.delay, 'lỗi');
        } else if (isManuallyStopped) {
            // Đảm bảo bot cũ được hủy bỏ ngay cả khi dừng thủ công
            if (bot) {
                bot.removeAllListeners();
                bot = null;
            }
            isAttemptingReconnect = false;
        } else {
            logger.info('ℹ️ KẾT NỐI LẠI: Đã có yêu cầu kết nối lại đang chờ xử lý từ sự kiện khác.');
        }
    });

    // Xử lý tin nhắn chat trong game
    bot.on('chat', (username, message) => {
        if (username === bot.username) return; // Bỏ qua tin nhắn của chính bot
        logger.info(`🗣️ [CHAT] <${username}>: ${message}`);
    });

    // Xử lý các tin nhắn hệ thống hoặc tin nhắn chung từ server
    bot.on('messagestr', (message, messagePosition, jsonMsg) => {
        if (messagePosition === 'chat' || messagePosition === 'system') {
            logger.info(`✉️ [SERVER MSG] ${message}`);
        }
    });

    // Xử lý sự kiện đăng nhập thành công
    bot.on('login', () => {
        logger.info(`✅ BOT: Đã gửi thông tin đăng nhập thành công.`);
    });
}

// =================================================================================================
// DualBotManager - Quản lý 2 bot Minecraft
// =================================================================================================
class DualBotManager {
    constructor() {
        this.isStopped = false;
        this.detectedVersion = null;
        this.activeBot = 'bot1';
        this.bots = {
            bot1: {
                bot: null,
                username: config.bot.bot1Username || `${config.bot.baseUsername}_1`,
                online: false,
                health: 0,
                food: 0,
                position: { x: 0, y: 0, z: 0 },
                startTime: null,
                status: 'Stopped',
                retryCount: 0,
                isConnecting: false,
                lastKick: null,
                afkIntervalId: null,
                autoChatIntervalId: null,
                reconnectTimeoutId: null,
            },
            bot2: {
                bot: null,
                username: config.bot.bot2Username || `${config.bot.baseUsername}_2`,
                online: false,
                health: 0,
                food: 0,
                position: { x: 0, y: 0, z: 0 },
                startTime: null,
                status: 'Stopped',
                retryCount: 0,
                isConnecting: false,
                lastKick: null,
                afkIntervalId: null,
                autoChatIntervalId: null,
                reconnectTimeoutId: null,
            }
        };
    }

    init() {
        if (this.isStopped) return;
        for (const id of Object.keys(this.bots)) {
            this._connectBot(id);
        }
    }

    _clearIntervals(state) {
        if (state.afkIntervalId) { clearInterval(state.afkIntervalId); state.afkIntervalId = null; }
        if (state.autoChatIntervalId) { clearInterval(state.autoChatIntervalId); state.autoChatIntervalId = null; }
        if (state.reconnectTimeoutId) { clearTimeout(state.reconnectTimeoutId); state.reconnectTimeoutId = null; }
    }

    _scheduleReconnect(id, delay, reason) {
        const state = this.bots[id];
        if (state.reconnectTimeoutId) { clearTimeout(state.reconnectTimeoutId); state.reconnectTimeoutId = null; }
        if (state.bot) { state.bot.removeAllListeners(); state.bot = null; }
        state.isConnecting = false;
        state.online = false;
        state.status = 'Reconnecting';

        const maxRetries = config.features.autoReconnect.maxRetries || 10;
        if (state.retryCount >= maxRetries) {
            logger.warn(`⚠️ ${id.toUpperCase()}: Đã đạt giới hạn thử kết nối lại (${maxRetries}). Dừng.`);
            state.status = 'Max retries reached';
            return;
        }

        state.retryCount++;
        logger.info(`🔄 ${id.toUpperCase()}: Kết nối lại sau ${delay / 1000}s do ${reason}... (lần ${state.retryCount})`);
        state.reconnectTimeoutId = setTimeout(() => {
            if (!this.isStopped) this._connectBot(id);
        }, delay);
    }

    _connectBot(id) {
        const state = this.bots[id];
        if (state.isConnecting || state.online) return;

        state.isConnecting = true;
        state.status = 'Connecting';

        logger.info(`🔗 ${id.toUpperCase()}: Đang kết nối với tên: ${state.username}`);

        let botInstance;
        try {
            botInstance = createBot({
                host: config.server.host,
                port: config.server.port,
                username: state.username,
                password: config.bot.password || undefined,
                auth: config.bot.auth || config.server.auth || 'offline',
                version: false,
                hideErrors: false
            });
            botInstance.loadPlugin(pathfinder);
        } catch (err) {
            logger.error(`❌ ${id.toUpperCase()}: Lỗi tạo bot: ${err.message}`);
            state.isConnecting = false;
            state.status = 'Error';
            this._scheduleReconnect(id, config.features.autoReconnect.delay, 'lỗi tạo bot');
            return;
        }

        state.bot = botInstance;

        botInstance.on('spawn', () => {
            if (this.isStopped) { botInstance.quit('stopped'); return; }
            state.online = true;
            state.isConnecting = false;
            state.startTime = performance.now();
            state.retryCount = 0;
            state.status = 'Online';
            this.detectedVersion = botInstance.version;
            logger.info(`✅ ${id.toUpperCase()}: Đã kết nối! (v${botInstance.version})`);

            this._clearIntervals(state);

            if (config.features.antiAfk.enabled) {
                const afkMin = config.features.antiAfk.minInterval;
                const afkMax = config.features.antiAfk.maxInterval;
                state.afkIntervalId = setInterval(async () => {
                    if (!state.online || !state.bot) return;
                    const actions = config.features.antiAfk.actions;
                    const possible = Object.keys(actions).filter(a => actions[a]);
                    if (!possible.length) return;
                    const act = possible[Math.floor(Math.random() * possible.length)];
                    try {
                        switch (act) {
                            case 'jump':
                                botInstance.setControlState('jump', true);
                                await botInstance.waitForTicks(5);
                                botInstance.setControlState('jump', false);
                                break;
                            case 'sneak':
                                botInstance.setControlState('sneak', !botInstance.getControlState('sneak'));
                                break;
                            case 'lookAround':
                                await botInstance.look(Math.random() * Math.PI * 2, Math.random() * Math.PI - Math.PI / 2, true);
                                break;
                            case 'swingArm':
                                botInstance.swingArm();
                                break;
                            case 'walkRandomly': {
                                const dirs = ['forward', 'back', 'left', 'right'];
                                const d = dirs[Math.floor(Math.random() * dirs.length)];
                                botInstance.setControlState(d, true);
                                await botInstance.waitForTicks(Math.floor(Math.random() * 20) + 10);
                                botInstance.setControlState(d, false);
                                break;
                            }
                            case 'toggleWalk': {
                                const d2 = Math.random() > 0.5 ? 'forward' : 'back';
                                botInstance.setControlState(d2, true);
                                await botInstance.waitForTicks(Math.floor(Math.random() * 40) + 10);
                                botInstance.setControlState(d2, false);
                                break;
                            }
                            case 'switchHotbar': {
                                const cur = botInstance.inventory.selectedHotbarFrame;
                                let ns = Math.floor(Math.random() * 9);
                                if (ns === cur) ns = (ns + 1) % 9;
                                botInstance.setQuickBarSlot(ns);
                                break;
                            }
                            case 'interactWithEntity': {
                                const ent = botInstance.nearestEntity();
                                if (ent) await botInstance.lookAt(ent.position.offset(0, ent.height || 1, 0), true);
                                break;
                            }
                            case 'inventoryInteraction': {
                                const items = botInstance.inventory.items();
                                if (items.length > 0) {
                                    const item = items[Math.floor(Math.random() * items.length)];
                                    logger.info(`🎒 ${id.toUpperCase()} AFK: inventory interaction with ${item.name}`);
                                }
                                break;
                            }
                            default: break;
                        }
                    } catch (e) {
                        logger.error(`❌ ${id.toUpperCase()} AFK action ${act}: ${e.message}`);
                    }
                }, Math.random() * (afkMax - afkMin) + afkMin);
            }

            if (config.features.autoChat.enabled && config.features.autoChat.messages.length > 0) {
                state.autoChatIntervalId = setInterval(() => {
                    if (!state.online || !state.bot) return;
                    const msgs = config.features.autoChat.messages;
                    const msg = msgs[Math.floor(Math.random() * msgs.length)];
                    botInstance.chat(msg);
                    logger.info(`🗣️ ${id.toUpperCase()} CHAT: "${msg}"`);
                }, config.features.autoChat.interval);
            }
        });

        botInstance.on('kicked', (reason) => {
            const r = typeof reason === 'object' ? JSON.stringify(reason) : reason;
            logger.error(`💥 ${id.toUpperCase()}: Bị kick! Lý do: "${r}"`);
            state.online = false;
            state.status = 'Kicked';
            state.lastKick = { timestamp: new Date().toISOString(), reason: r };
            this._clearIntervals(state);

            if (config.features.randomUsernameOnKick.enabled) {
                const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
                const len = config.features.randomUsernameOnKick.length || 4;
                const suffix = Array.from({ length: len }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
                state.username = `${config.bot.baseUsername}-${suffix}`;
                logger.info(`👤 ${id.toUpperCase()}: Đổi tên thành: ${state.username}`);
            }

            if (!this.isStopped && config.features.autoReconnect.enabled) {
                this._scheduleReconnect(id, config.features.autoReconnect.kickDelay, 'bị kick');
            }
        });

        botInstance.on('end', (reason) => {
            logger.info(`💔 ${id.toUpperCase()}: Mất kết nối. Lý do: "${reason}"`);
            state.online = false;
            state.isConnecting = false;
            state.status = 'Disconnected';
            this._clearIntervals(state);

            if (!this.isStopped && config.features.autoReconnect.enabled && !state.reconnectTimeoutId) {
                this._scheduleReconnect(id, config.features.autoReconnect.delay, 'mất kết nối');
            }
        });

        botInstance.on('error', (err) => {
            logger.error(`🐛 ${id.toUpperCase()} LỖI: ${err.message}`);
            state.online = false;
            state.isConnecting = false;
            state.status = 'Error';
            this._clearIntervals(state);

            if (!this.isStopped && config.features.autoReconnect.enabled && !state.reconnectTimeoutId) {
                this._scheduleReconnect(id, config.features.autoReconnect.delay, 'lỗi');
            }
        });

        botInstance.on('chat', (username, message) => {
            if (username === botInstance.username) return;
            logger.info(`🗣️ [${id.toUpperCase()} CHAT] <${username}>: ${message}`);
        });

        botInstance.on('login', () => {
            logger.info(`✅ ${id.toUpperCase()}: Đăng nhập thành công.`);
        });

        botInstance.on('health', () => {
            state.health = botInstance.health;
            state.food = botInstance.food;
            if (botInstance.entity) {
                state.position = {
                    x: parseFloat(botInstance.entity.position.x.toFixed(2)),
                    y: parseFloat(botInstance.entity.position.y.toFixed(2)),
                    z: parseFloat(botInstance.entity.position.z.toFixed(2))
                };
            }
        });
    }

    stopAll() {
        this.isStopped = true;
        for (const [id, state] of Object.entries(this.bots)) {
            this._clearIntervals(state);
            if (state.bot) {
                try { state.bot.quit('Stopped by command'); } catch (e) {}
                state.bot.removeAllListeners();
                state.bot = null;
            }
            state.online = false;
            state.isConnecting = false;
            state.status = 'Stopped';
        }
        logger.info('🛑 DUAL BOT: Tất cả bot đã dừng.');
    }

    startAll() {
        this.isStopped = false;
        for (const [id, state] of Object.entries(this.bots)) {
            state.retryCount = 0;
            state.isConnecting = false;
        }
        this.init();
    }

    sendChat(message) {
        const activeState = this.bots[this.activeBot];
        if (activeState.online && activeState.bot) {
            activeState.bot.chat(message);
            return true;
        }
        for (const [id, state] of Object.entries(this.bots)) {
            if (state.online && state.bot) {
                state.bot.chat(message);
                return true;
            }
        }
        return false;
    }

    getStatusSummary() {
        const now = performance.now();
        const summary = { activeBot: this.activeBot, detectedVersion: this.detectedVersion, bots: {} };
        for (const [id, state] of Object.entries(this.bots)) {
            summary.bots[id] = {
                id, username: state.username, online: state.online,
                health: state.health, food: state.food,
                position: state.position, status: state.status,
                uptime: state.startTime && state.online ? now - state.startTime : 0,
                retryCount: state.retryCount, lastKick: state.lastKick,
                isActive: id === this.activeBot
            };
        }
        return summary;
    }
}
// =================================================================================================
// Init Manager
// =================================================================================================
const manager = new DualBotManager();
// Tự động khởi động khi app chạy
manager.init();

// =================================================================================================
// Express Web Dashboard
// =================================================================================================
const app = express();
const REPLIT_PORT = process.env.PORT || config.features.webDashboard.port || 3000;
app.use(express.json());
app.use(cors());

app.get('/logs', (req, res) => res.json(recentLogs));

app.get('/status', (req, res) => res.json(manager.getStatusSummary()));

app.post('/chat', (req, res) => {
    const { message } = req.body;
    if (!message?.trim()) return res.status(400).json({ success: false, message: 'Tin nhắn trống.' });
    const ok = manager.sendChat(message.trim());
    if (ok) {
        logger.info(`✉️ DASHBOARD: Chat gửi: "${message}"`);
        res.json({ success: true, message: 'Đã gửi.' });
    } else {
        res.status(400).json({ success: false, message: 'Không có bot nào online.' });
    }
});

app.post('/command', (req, res) => {
    const { action } = req.body;
    if (action === 'start') {
        manager.startAll();
        res.json({ success: true, message: 'Đang khởi động 2 bot...' });
    } else if (action === 'stop') {
        manager.stopAll();
        res.json({ success: true, message: 'Đã dừng tất cả bot.' });
    } else if (action === 'reconnect') {
        manager.stopAll();
        setTimeout(() => manager.startAll(), 2000);
        res.json({ success: true, message: 'Đang khởi động lại 2 bot...' });
    } else {
        res.status(400).json({ success: false, message: `Lệnh không hợp lệ: ${action}` });
    }
});

app.get('/config', (req, res) => {
    res.json({
        host: config.server.host,
        port: config.server.port,
        bot1Username: config.bot.bot1Username || `${config.bot.baseUsername}_1`,
        bot2Username: config.bot.bot2Username || `${config.bot.baseUsername}_2`,
        auth: config.bot.auth || config.server.auth || 'offline',
    });
});

app.post('/config', (req, res) => {
    const { host, port, bot1Username, bot2Username, auth } = req.body;
    if (!host || !port) return res.status(400).json({ success: false, message: 'Host và Port không được trống.' });
    const portNum = parseInt(port);
    if (isNaN(portNum) || portNum < 1 || portNum > 65535)
        return res.status(400).json({ success: false, message: 'Port không hợp lệ (1-65535).' });

    config.server.host = host.trim();
    config.server.port = portNum;
    if (auth) config.bot.auth = auth;
    if (bot1Username?.trim()) {
        config.bot.bot1Username = bot1Username.trim();
        if (manager.bots.bot1) manager.bots.bot1.username = bot1Username.trim();
    }
    if (bot2Username?.trim()) {
        config.bot.bot2Username = bot2Username.trim();
        if (manager.bots.bot2) manager.bots.bot2.username = bot2Username.trim();
    }

    try {
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
        logger.info(`⚙️ CONFIG: Đã cập nhật — Host: ${config.server.host}:${config.server.port}`);
        res.json({ success: true, message: `Đã lưu! Server: ${config.server.host}:${config.server.port}. Nhấn Restart để áp dụng.` });
    } catch (err) {
        logger.error(`❌ CONFIG: Lỗi lưu config: ${err.message}`);
        res.status(500).json({ success: false, message: 'Lỗi khi lưu file config.' });
    }
});

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="vi">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Minecraft Dual Bot Dashboard</title>
    <link rel="icon" href="https://img.icons8.com/plasticine/100/minecraft-cube.png" type="image/png">
    <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
    <style>
        :root {
            --bg: #0d1117;
            --surface: #161b22;
            --surface2: #21262d;
            --border: #30363d;
            --text: #e6edf3;
            --text-muted: #8b949e;
            --green: #3fb950;
            --red: #f85149;
            --yellow: #d29922;
            --blue: #58a6ff;
            --purple: #bc8cff;
            --orange: #ffa657;
            --active-glow: 0 0 20px rgba(63,185,80,0.3);
            --backup-glow: 0 0 20px rgba(88,166,255,0.2);
        }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: 'Inter', sans-serif;
            background: var(--bg);
            color: var(--text);
            min-height: 100vh;
            padding: 20px;
        }
        .header {
            text-align: center;
            padding: 24px 0 32px;
        }
        .header h1 {
            font-size: 2rem;
            font-weight: 700;
            background: linear-gradient(135deg, var(--green), var(--blue));
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            margin-bottom: 6px;
        }
        .header p { color: var(--text-muted); font-size: 0.9rem; }

        .server-bar {
            background: var(--surface);
            border: 1px solid var(--border);
            border-radius: 10px;
            padding: 14px 20px;
            display: flex;
            align-items: center;
            gap: 16px;
            margin-bottom: 20px;
            flex-wrap: wrap;
        }
        .server-bar .label { color: var(--text-muted); font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.05em; }
        .server-bar .value { font-family: 'JetBrains Mono', monospace; font-size: 0.9rem; color: var(--blue); }
        .server-bar .sep { color: var(--border); }
        .version-badge {
            background: var(--surface2);
            border: 1px solid var(--border);
            border-radius: 20px;
            padding: 3px 12px;
            font-size: 0.78rem;
            font-family: 'JetBrains Mono', monospace;
            color: var(--orange);
        }
        .detect-dot {
            width: 8px; height: 8px; border-radius: 50%;
            background: var(--yellow);
            animation: pulse 2s infinite;
            flex-shrink: 0;
        }
        .detect-dot.ok { background: var(--green); animation: none; }

        .bots-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 16px;
            margin-bottom: 20px;
        }
        @media (max-width: 700px) { .bots-grid { grid-template-columns: 1fr; } }

        .bot-card {
            background: var(--surface);
            border: 1px solid var(--border);
            border-radius: 12px;
            padding: 20px;
            position: relative;
            transition: box-shadow 0.3s;
        }
        .bot-card.active { border-color: var(--green); box-shadow: var(--active-glow); }
        .bot-card.backup { border-color: var(--blue); box-shadow: var(--backup-glow); }
        .bot-card.offline { border-color: var(--border); opacity: 0.75; }

        .bot-header {
            display: flex;
            align-items: center;
            gap: 10px;
            margin-bottom: 16px;
        }
        .bot-icon {
            width: 36px; height: 36px;
            border-radius: 8px;
            display: flex; align-items: center; justify-content: center;
            font-size: 1.2rem;
        }
        .bot-icon.active-icon { background: rgba(63,185,80,0.15); }
        .bot-icon.backup-icon { background: rgba(88,166,255,0.15); }
        .bot-icon.offline-icon { background: rgba(248,81,73,0.1); }

        .bot-name { font-weight: 600; font-size: 1rem; }
        .bot-role-badge {
            margin-left: auto;
            padding: 3px 10px;
            border-radius: 20px;
            font-size: 0.72rem;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.05em;
        }
        .badge-active { background: rgba(63,185,80,0.15); color: var(--green); border: 1px solid rgba(63,185,80,0.3); }
        .badge-backup { background: rgba(88,166,255,0.12); color: var(--blue); border: 1px solid rgba(88,166,255,0.3); }
        .badge-offline { background: rgba(248,81,73,0.1); color: var(--red); border: 1px solid rgba(248,81,73,0.2); }
        .badge-connecting { background: rgba(210,153,34,0.12); color: var(--yellow); border: 1px solid rgba(210,153,34,0.3); }

        .bot-stats {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 10px;
            margin-bottom: 14px;
        }
        .stat { background: var(--surface2); border-radius: 8px; padding: 10px 12px; }
        .stat-label { font-size: 0.72rem; color: var(--text-muted); margin-bottom: 4px; text-transform: uppercase; letter-spacing: 0.04em; }
        .stat-value { font-family: 'JetBrains Mono', monospace; font-size: 0.92rem; font-weight: 600; color: var(--text); }
        .stat-value.green { color: var(--green); }
        .stat-value.red { color: var(--red); }
        .stat-value.yellow { color: var(--yellow); }
        .stat-value.blue { color: var(--blue); }

        .bot-status-bar {
            background: var(--surface2);
            border-radius: 6px;
            padding: 8px 12px;
            font-size: 0.8rem;
            color: var(--text-muted);
            font-family: 'JetBrains Mono', monospace;
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .status-dot {
            width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0;
        }
        .dot-green { background: var(--green); box-shadow: 0 0 6px var(--green); animation: pulse 2s infinite; }
        .dot-blue { background: var(--blue); box-shadow: 0 0 6px var(--blue); animation: pulse 2s infinite; }
        .dot-red { background: var(--red); }
        .dot-yellow { background: var(--yellow); animation: pulse 1s infinite; }

        @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.4; }
        }

        .panel {
            background: var(--surface);
            border: 1px solid var(--border);
            border-radius: 12px;
            padding: 20px;
            margin-bottom: 16px;
        }
        .panel-title {
            font-size: 0.8rem;
            font-weight: 600;
            color: var(--text-muted);
            text-transform: uppercase;
            letter-spacing: 0.08em;
            margin-bottom: 14px;
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .panel-title::after {
            content: '';
            flex: 1;
            height: 1px;
            background: var(--border);
        }

        .controls { display: flex; gap: 10px; flex-wrap: wrap; }
        .btn {
            padding: 9px 20px;
            border-radius: 8px;
            border: 1px solid transparent;
            font-size: 0.88rem;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.2s;
            font-family: 'Inter', sans-serif;
        }
        .btn:disabled { opacity: 0.4; cursor: not-allowed; }
        .btn-green { background: rgba(63,185,80,0.15); border-color: rgba(63,185,80,0.4); color: var(--green); }
        .btn-green:hover:not(:disabled) { background: rgba(63,185,80,0.25); }
        .btn-blue { background: rgba(88,166,255,0.12); border-color: rgba(88,166,255,0.3); color: var(--blue); }
        .btn-blue:hover:not(:disabled) { background: rgba(88,166,255,0.22); }
        .btn-red { background: rgba(248,81,73,0.1); border-color: rgba(248,81,73,0.3); color: var(--red); }
        .btn-red:hover:not(:disabled) { background: rgba(248,81,73,0.2); }
        .btn-orange { background: rgba(255,166,87,0.1); border-color: rgba(255,166,87,0.3); color: var(--orange); }
        .btn-orange:hover:not(:disabled) { background: rgba(255,166,87,0.2); }

        .chat-row { display: flex; gap: 10px; }
        .chat-input {
            flex: 1;
            background: var(--surface2);
            border: 1px solid var(--border);
            border-radius: 8px;
            color: var(--text);
            padding: 9px 14px;
            font-size: 0.88rem;
            font-family: 'Inter', sans-serif;
            outline: none;
        }
        .chat-input:focus { border-color: var(--blue); }
        .chat-input:disabled { opacity: 0.4; }

        .logs-box {
            background: var(--surface2);
            border-radius: 8px;
            padding: 14px;
            height: 280px;
            overflow-y: auto;
            font-family: 'JetBrains Mono', monospace;
            font-size: 0.78rem;
            line-height: 1.6;
        }
        .log-entry { padding: 2px 0; border-bottom: 1px solid rgba(255,255,255,0.04); }
        .log-entry:last-child { border-bottom: none; }
        .log-entry.info { color: var(--green); }
        .log-entry.warn { color: var(--yellow); }
        .log-entry.error { color: var(--red); }

        .toast {
            position: fixed; bottom: 24px; right: 24px;
            background: var(--surface);
            border: 1px solid var(--border);
            border-radius: 10px;
            padding: 12px 18px;
            font-size: 0.88rem;
            box-shadow: 0 8px 24px rgba(0,0,0,0.4);
            transform: translateY(80px);
            opacity: 0;
            transition: all 0.3s;
            max-width: 320px;
            z-index: 999;
        }
        .toast.show { transform: translateY(0); opacity: 1; }
        .toast.success { border-color: var(--green); color: var(--green); }
        .toast.error { border-color: var(--red); color: var(--red); }
        .toast.info { border-color: var(--blue); color: var(--blue); }

        .swap-indicator {
            text-align: center;
            font-size: 0.78rem;
            color: var(--text-muted);
            margin: -8px 0 20px;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 8px;
        }
        .swap-arrow { color: var(--orange); font-size: 1rem; }

        /* ── Tabs ── */
        .tabs {
            display: flex;
            gap: 4px;
            margin-bottom: 20px;
            background: var(--surface);
            border: 1px solid var(--border);
            border-radius: 10px;
            padding: 5px;
        }
        .tab-btn {
            flex: 1;
            padding: 8px 0;
            border: none;
            border-radius: 7px;
            background: transparent;
            color: var(--text-muted);
            font-size: 0.88rem;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.2s;
            font-family: 'Inter', sans-serif;
        }
        .tab-btn.active {
            background: var(--surface2);
            color: var(--text);
            border: 1px solid var(--border);
        }
        .tab-btn:hover:not(.active) { color: var(--text); }

        .tab-page { display: none; }
        .tab-page.active { display: block; }

        /* ── Settings form ── */
        .settings-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 14px;
        }
        @media (max-width: 600px) { .settings-grid { grid-template-columns: 1fr; } }
        .field { display: flex; flex-direction: column; gap: 6px; }
        .field-full { grid-column: 1 / -1; }
        .field label {
            font-size: 0.75rem;
            font-weight: 600;
            color: var(--text-muted);
            text-transform: uppercase;
            letter-spacing: 0.06em;
        }
        .field input, .field select {
            background: var(--surface2);
            border: 1px solid var(--border);
            border-radius: 8px;
            color: var(--text);
            padding: 9px 12px;
            font-size: 0.9rem;
            font-family: 'JetBrains Mono', monospace;
            outline: none;
            transition: border-color 0.2s;
        }
        .field input:focus, .field select:focus { border-color: var(--blue); }
        .field select option { background: var(--surface2); }
        .settings-note {
            font-size: 0.78rem;
            color: var(--text-muted);
            background: var(--surface2);
            border-radius: 6px;
            padding: 8px 12px;
            margin-top: 4px;
        }
    </style>
</head>
<body>

<div class="header">
    <h1>⚔️ Minecraft Dual Bot</h1>
    <p>Hệ thống 2 bot thay ca — tự động backup khi 1 con die</p>
</div>

<!-- Tabs -->
<div class="tabs">
    <button class="tab-btn active" onclick="switchTab('dashboard')">📊 Dashboard</button>
    <button class="tab-btn" onclick="switchTab('settings')">⚙️ Settings</button>
</div>

<div class="tab-page active" id="tab-dashboard">
<div class="server-bar">
    <div class="detect-dot" id="detectDot"></div>
    <div>
        <div class="label">Server</div>
        <div class="value" id="serverHost">Đang tải...</div>
    </div>
    <div class="sep">|</div>
    <div>
        <div class="label">Version phát hiện</div>
        <div class="value" id="serverVersion">—</div>
    </div>
    <div class="sep">|</div>
    <div>
        <div class="label">Active Bot</div>
        <div class="value" id="activeBotLabel">—</div>
    </div>
    <span class="version-badge" id="versionBadge">AUTO-DETECT</span>
</div>

<!-- Dual Bot Cards -->
<div class="bots-grid" id="botsGrid">
    <div class="bot-card offline" id="card-bot1">
        <div class="bot-header">
            <div class="bot-icon offline-icon" id="icon-bot1">🤖</div>
            <div>
                <div class="bot-name" id="name-bot1">Bot 1</div>
                <div style="font-size:0.75rem;color:var(--text-muted)" id="user-bot1">—</div>
            </div>
            <span class="bot-role-badge badge-offline" id="badge-bot1">Offline</span>
        </div>
        <div class="bot-stats">
            <div class="stat">
                <div class="stat-label">❤️ HP</div>
                <div class="stat-value" id="health-bot1">—</div>
            </div>
            <div class="stat">
                <div class="stat-label">🍖 Đói</div>
                <div class="stat-value" id="food-bot1">—</div>
            </div>
            <div class="stat">
                <div class="stat-label">📍 Vị trí</div>
                <div class="stat-value blue" id="pos-bot1">—</div>
            </div>
            <div class="stat">
                <div class="stat-label">⏱️ Uptime</div>
                <div class="stat-value" id="uptime-bot1">—</div>
            </div>
        </div>
        <div class="bot-status-bar">
            <div class="status-dot dot-red" id="dot-bot1"></div>
            <span id="status-bot1">Chờ khởi động</span>
        </div>
    </div>

    <div class="bot-card offline" id="card-bot2">
        <div class="bot-header">
            <div class="bot-icon offline-icon" id="icon-bot2">🛡️</div>
            <div>
                <div class="bot-name" id="name-bot2">Bot 2</div>
                <div style="font-size:0.75rem;color:var(--text-muted)" id="user-bot2">—</div>
            </div>
            <span class="bot-role-badge badge-offline" id="badge-bot2">Offline</span>
        </div>
        <div class="bot-stats">
            <div class="stat">
                <div class="stat-label">❤️ HP</div>
                <div class="stat-value" id="health-bot2">—</div>
            </div>
            <div class="stat">
                <div class="stat-label">🍖 Đói</div>
                <div class="stat-value" id="food-bot2">—</div>
            </div>
            <div class="stat">
                <div class="stat-label">📍 Vị trí</div>
                <div class="stat-value blue" id="pos-bot2">—</div>
            </div>
            <div class="stat">
                <div class="stat-label">⏱️ Uptime</div>
                <div class="stat-value" id="uptime-bot2">—</div>
            </div>
        </div>
        <div class="bot-status-bar">
            <div class="status-dot dot-red" id="dot-bot2"></div>
            <span id="status-bot2">Chờ khởi động</span>
        </div>
    </div>
</div>

<div class="swap-indicator">
    <span>Bot 1</span>
    <span class="swap-arrow">⇄</span>
    <span>Tự động thay ca khi 1 con die</span>
    <span class="swap-arrow">⇄</span>
    <span>Bot 2</span>
</div>

<!-- Controls -->
<div class="panel">
    <div class="panel-title">Điều khiển</div>
    <div class="controls">
        <button class="btn btn-green" id="startBtn" onclick="sendCmd('start')">▶ Khởi động 2 Bot</button>
        <button class="btn btn-orange" id="reconnectBtn" onclick="sendCmd('reconnect')">↺ Restart All</button>
        <button class="btn btn-red" id="stopBtn" onclick="sendCmd('stop')">■ Dừng tất cả</button>
    </div>
</div>

<!-- Chat -->
<div class="panel">
    <div class="panel-title">Chat (gửi qua Active Bot)</div>
    <div class="chat-row">
        <input class="chat-input" id="chatInput" placeholder="Nhập tin nhắn..." disabled>
        <button class="btn btn-blue" id="chatBtn" onclick="sendChat()" disabled>Gửi</button>
    </div>
</div>

<!-- Logs -->
<div class="panel">
    <div class="panel-title">Console Log</div>
    <div class="logs-box" id="logsBox"></div>
</div>

</div><!-- end tab-dashboard -->

<!-- Settings Tab -->
<div class="tab-page" id="tab-settings">
<div class="panel">
    <div class="panel-title">⚙️ Cấu hình Server & Bot</div>
    <div class="settings-grid">
        <div class="field">
            <label>🌐 Server Host</label>
            <input type="text" id="cfgHost" placeholder="vd: play.hypixel.net">
        </div>
        <div class="field">
            <label>🔌 Port</label>
            <input type="number" id="cfgPort" placeholder="25565" min="1" max="65535">
        </div>
        <div class="field">
            <label>🤖 Tên Bot 1</label>
            <input type="text" id="cfgBot1" placeholder="AFKBot_1">
        </div>
        <div class="field">
            <label>🛡️ Tên Bot 2</label>
            <input type="text" id="cfgBot2" placeholder="AFKBot_2">
        </div>
        <div class="field field-full">
            <label>🔑 Chế độ Auth</label>
            <select id="cfgAuth">
                <option value="offline">offline (cracked / không cần tài khoản)</option>
                <option value="microsoft">microsoft (tài khoản chính thức)</option>
            </select>
        </div>
    </div>
    <div class="settings-note" style="margin-top:14px">
        ⚠️ Sau khi lưu, nhấn <strong>Restart All</strong> ở tab Dashboard để bot kết nối với server mới.
    </div>
    <div style="margin-top:14px;display:flex;gap:10px;flex-wrap:wrap">
        <button class="btn btn-blue" onclick="saveConfig()">💾 Lưu cấu hình</button>
        <button class="btn btn-orange" onclick="loadConfig()">↺ Tải lại từ server</button>
    </div>
</div>
</div><!-- end tab-settings -->

<div class="toast" id="toast"></div>

<script>
const BASE = window.location.origin;
let toastTimer;

function toast(msg, type='info') {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.className = \`toast show \${type}\`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 3000);
}

function formatUptime(ms) {
    if (!ms) return '—';
    const s = Math.floor(ms/1000);
    const h = Math.floor(s/3600), m = Math.floor((s%3600)/60), sec = s%60;
    if (h > 0) return \`\${h}h \${m}m \${sec}s\`;
    if (m > 0) return \`\${m}m \${sec}s\`;
    return \`\${sec}s\`;
}

function updateBotCard(id, data) {
    const card = document.getElementById(\`card-\${id}\`);
    const badge = document.getElementById(\`badge-\${id}\`);
    const dot = document.getElementById(\`dot-\${id}\`);
    const icon = document.getElementById(\`icon-\${id}\`);

    document.getElementById(\`name-\${id}\`).textContent = id === 'bot1' ? 'Bot 1' : 'Bot 2';
    document.getElementById(\`user-\${id}\`).textContent = data.username || '—';
    document.getElementById(\`health-\${id}\`).textContent = data.online ? \`\${Math.round(data.health)} / 20\` : '—';
    document.getElementById(\`food-\${id}\`).textContent = data.online ? \`\${Math.round(data.food)} / 20\` : '—';
    document.getElementById(\`pos-\${id}\`).textContent = data.online && data.position
        ? \`\${data.position.x} / \${data.position.y} / \${data.position.z}\` : '—';
    document.getElementById(\`uptime-\${id}\`).textContent = formatUptime(data.uptime);
    document.getElementById(\`status-\${id}\`).textContent = data.status || '—';

    // Card class & badge
    card.className = 'bot-card';
    dot.className = 'status-dot';
    icon.className = 'bot-icon';

    if (data.online && data.isActive) {
        card.classList.add('active');
        badge.className = 'bot-role-badge badge-active';
        badge.textContent = '🎯 ACTIVE';
        dot.classList.add('dot-green');
        icon.classList.add('active-icon');
        icon.textContent = '🎯';
    } else if (data.online && !data.isActive) {
        card.classList.add('backup');
        badge.className = 'bot-role-badge badge-backup';
        badge.textContent = '🛡️ BACKUP';
        dot.classList.add('dot-blue');
        icon.classList.add('backup-icon');
        icon.textContent = '🛡️';
    } else if (data.status && (data.status.includes('Retry') || data.status.includes('kết nối'))) {
        card.classList.add('offline');
        badge.className = 'bot-role-badge badge-connecting';
        badge.textContent = '⏳ Retry...';
        dot.classList.add('dot-yellow');
        icon.classList.add('offline-icon');
        icon.textContent = '⏳';
    } else {
        card.classList.add('offline');
        badge.className = 'bot-role-badge badge-offline';
        badge.textContent = 'Offline';
        dot.classList.add('dot-red');
        icon.classList.add('offline-icon');
        icon.textContent = '💀';
    }

    // Health color
    const healthEl = document.getElementById(\`health-\${id}\`);
    if (data.online) {
        healthEl.className = data.health > 14 ? 'stat-value green' : data.health > 7 ? 'stat-value yellow' : 'stat-value red';
    }
}

async function updateStatus() {
    try {
        const res = await fetch(\`\${BASE}/status\`);
        const data = await res.json();

        // Server bar
        document.getElementById('serverHost').textContent = \`\${location.hostname}:\${location.port || 3000}\`;
        const ver = data.detectedVersion;
        document.getElementById('serverVersion').textContent = ver || 'Auto';
        document.getElementById('activeBotLabel').textContent = data.activeBot || '—';
        const badge = document.getElementById('versionBadge');
        badge.textContent = ver ? \`v\${ver}\` : 'AUTO';
        const dot = document.getElementById('detectDot');
        dot.className = ver ? 'detect-dot ok' : 'detect-dot';

        // Bot cards
        const bots = data.bots || {};
        updateBotCard('bot1', bots.bot1 || {});
        updateBotCard('bot2', bots.bot2 || {});

        // Chat enable if any bot online
        const anyOnline = (bots.bot1?.online || bots.bot2?.online);
        document.getElementById('chatInput').disabled = !anyOnline;
        document.getElementById('chatBtn').disabled = !anyOnline;
    } catch(e) {}
}

async function sendCmd(action) {
    try {
        const res = await fetch(\`\${BASE}/command\`, {
            method: 'POST',
            headers: {'Content-Type':'application/json'},
            body: JSON.stringify({action})
        });
        const data = await res.json();
        toast(data.message, data.success ? 'success' : 'error');
        setTimeout(updateStatus, 1000);
    } catch(e) { toast('Lỗi kết nối server!', 'error'); }
}

async function sendChat() {
    const input = document.getElementById('chatInput');
    const msg = input.value.trim();
    if (!msg) return;
    try {
        const res = await fetch(\`\${BASE}/chat\`, {
            method: 'POST',
            headers: {'Content-Type':'application/json'},
            body: JSON.stringify({message: msg})
        });
        const data = await res.json();
        toast(data.message, data.success ? 'success' : 'error');
        if (data.success) input.value = '';
    } catch(e) { toast('Lỗi!', 'error'); }
}

document.getElementById('chatInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') sendChat();
});

function switchTab(name) {
    document.querySelectorAll('.tab-page').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.getElementById(\`tab-\${name}\`).classList.add('active');
    event.target.classList.add('active');
    if (name === 'settings') loadConfig();
}

async function loadConfig() {
    try {
        const res = await fetch(\`\${BASE}/config\`);
        const d = await res.json();
        document.getElementById('cfgHost').value = d.host || '';
        document.getElementById('cfgPort').value = d.port || 25565;
        document.getElementById('cfgBot1').value = d.bot1Username || '';
        document.getElementById('cfgBot2').value = d.bot2Username || '';
        document.getElementById('cfgAuth').value = d.auth || 'offline';
    } catch(e) { toast('Không thể tải config!', 'error'); }
}

async function saveConfig() {
    const host = document.getElementById('cfgHost').value.trim();
    const port = document.getElementById('cfgPort').value.trim();
    const bot1Username = document.getElementById('cfgBot1').value.trim();
    const bot2Username = document.getElementById('cfgBot2').value.trim();
    const auth = document.getElementById('cfgAuth').value;
    if (!host || !port) { toast('Host và Port không được trống!', 'error'); return; }
    try {
        const res = await fetch(\`\${BASE}/config\`, {
            method: 'POST',
            headers: {'Content-Type':'application/json'},
            body: JSON.stringify({ host, port, bot1Username, bot2Username, auth })
        });
        const data = await res.json();
        toast(data.message, data.success ? 'success' : 'error');
    } catch(e) { toast('Lỗi kết nối server!', 'error'); }
}

async function fetchLogs() {
    try {
        const res = await fetch(\`\${BASE}/logs\`);
        const logs = await res.json();
        const box = document.getElementById('logsBox');
        const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
        box.innerHTML = logs.map(l =>
            \`<div class="log-entry \${l.level.toLowerCase()}">\${l.timestamp} \${l.emoji} \${l.level.toUpperCase()}: \${l.message}</div>\`
        ).join('');
        if (atBottom) box.scrollTop = box.scrollHeight;
    } catch(e) {}
}

updateStatus();
fetchLogs();
setInterval(updateStatus, 1500);
setInterval(fetchLogs, 2000);
</script>
</body>
</html>
`;
app.get('/', (req, res) => res.send(DASHBOARD_HTML));

if (config.features.webDashboard.enabled) {
    app.listen(REPLIT_PORT, () => {
        logger.info(`🌐 DASHBOARD: http://localhost:${REPLIT_PORT}`);
    });
}

process.on('unhandledRejection', (reason) => logger.error(`❌ Unhandled Rejection: ${reason}`));
process.on('uncaughtException', (err) => logger.error(`❌ Uncaught Exception: ${err.message}`));
