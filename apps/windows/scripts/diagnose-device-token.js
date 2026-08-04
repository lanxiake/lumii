/**
 * 设备 Token 诊断脚本
 *
 * 用于诊断设备连接 Gateway 时的 token 问题
 *
 * 使用方法：
 * node scripts/diagnose-device-token.js <deviceId> <accessToken>
 */

const https = require('https');
const http = require('http');

const API_BASE_URL = process.env.OPENCLAW_API_BASE_URL || 'http://127.0.0.1:3000';

// 解析命令行参数
const args = process.argv.slice(2);
if (args.length < 2) {
  console.error('用法: node diagnose-device-token.js <deviceId> <accessToken>');
  console.error('');
  console.error('示例:');
  console.error('  node diagnose-device-token.js c34ee63c-24ea-b072-a949-61ab6448d0dd eyJhbGc...');
  process.exit(1);
}

const [deviceId, accessToken] = args;

console.log('='.repeat(80));
console.log('设备 Token 诊断工具');
console.log('='.repeat(80));
console.log('');
console.log(`设备 ID: ${deviceId}`);
console.log(`Access Token: ${accessToken.substring(0, 20)}...`);
console.log('');

/**
 * 发送 HTTP 请求
 */
function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const client = urlObj.protocol === 'https:' ? https : http;

    const req = client.request(url, options, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve({ statusCode: res.statusCode, data: json });
        } catch (error) {
          resolve({ statusCode: res.statusCode, data });
        }
      });
    });

    req.on('error', reject);
    req.end();
  });
}

/**
 * 查询设备 Token
 */
async function getDeviceToken() {
  console.log('1. 查询设备 Token');
  console.log('-'.repeat(80));

  try {
    const url = `${API_BASE_URL}/api/devices/${deviceId}/token`;
    const response = await request(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    });

    console.log(`状态码: ${response.statusCode}`);

    if (response.statusCode === 200 && response.data.success) {
      const { token, role, scopes } = response.data.data;
      console.log('✅ 成功获取设备 Token');
      console.log('');
      console.log(`Token: ${token.substring(0, 8)}...（长度: ${token.length}）`);
      console.log(`Role: ${role}`);
      console.log(`Scopes: ${JSON.stringify(scopes)}`);
      console.log('');
      return { token, role, scopes };
    } else {
      console.log('❌ 获取设备 Token 失败');
      console.log('响应:', JSON.stringify(response.data, null, 2));
      console.log('');
      return null;
    }
  } catch (error) {
    console.log('❌ 请求失败:', error.message);
    console.log('');
    return null;
  }
}

/**
 * 查询设备列表
 */
async function getUserDevices() {
  console.log('2. 查询用户设备列表');
  console.log('-'.repeat(80));

  try {
    const url = `${API_BASE_URL}/api/devices`;
    const response = await request(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    });

    console.log(`状态码: ${response.statusCode}`);

    if (response.statusCode === 200 && response.data.success) {
      const devices = response.data.data.devices;
      console.log(`✅ 找到 ${devices.length} 个设备`);
      console.log('');

      const targetDevice = devices.find(d => d.deviceId === deviceId);
      if (targetDevice) {
        console.log('目标设备信息:');
        console.log(`  设备 ID: ${targetDevice.deviceId}`);
        console.log(`  显示名称: ${targetDevice.displayName}`);
        console.log(`  别名: ${targetDevice.alias || '无'}`);
        console.log(`  平台: ${targetDevice.platform}`);
        console.log(`  主设备: ${targetDevice.isPrimary ? '是' : '否'}`);
        console.log(`  最后活跃: ${targetDevice.lastActiveAt || '未知'}`);
        console.log('');
        return targetDevice;
      } else {
        console.log('❌ 未找到目标设备');
        console.log('');
        console.log('可用设备列表:');
        devices.forEach(d => {
          console.log(`  - ${d.deviceId} (${d.displayName})`);
        });
        console.log('');
        return null;
      }
    } else {
      console.log('❌ 查询设备列表失败');
      console.log('响应:', JSON.stringify(response.data, null, 2));
      console.log('');
      return null;
    }
  } catch (error) {
    console.log('❌ 请求失败:', error.message);
    console.log('');
    return null;
  }
}

/**
 * 主函数
 */
async function main() {
  const tokenInfo = await getDeviceToken();
  const deviceInfo = await getUserDevices();

  console.log('='.repeat(80));
  console.log('诊断结果');
  console.log('='.repeat(80));
  console.log('');

  if (!tokenInfo) {
    console.log('❌ 无法获取设备 Token');
    console.log('');
    console.log('可能原因:');
    console.log('  1. Access Token 无效或已过期');
    console.log('  2. 设备 ID 不存在');
    console.log('  3. 设备不属于当前用户');
    console.log('  4. API Server 未运行或地址错误');
    console.log('');
    process.exit(1);
  }

  if (!deviceInfo) {
    console.log('❌ 设备不在用户设备列表中');
    console.log('');
    console.log('可能原因:');
    console.log('  1. 设备已被删除');
    console.log('  2. 设备未完成配对');
    console.log('  3. 设备属于其他用户');
    console.log('');
    process.exit(1);
  }

  console.log('✅ 设备状态正常');
  console.log('');
  console.log('建议操作:');
  console.log('  1. 在 Windows 客户端连接时使用以下参数:');
  console.log(`     deviceId: ${deviceId}`);
  console.log(`     token: ${tokenInfo.token}`);
  console.log(`     role: ${tokenInfo.role}`);
  console.log(`     scopes: ${JSON.stringify(tokenInfo.scopes)}`);
  console.log('');
  console.log('  2. 或者在连接时启用 autoRefreshToken 选项:');
  console.log('     await ipc.invoke("gateway:connect", gatewayUrl, {');
  console.log(`       deviceId: "${deviceId}",`);
  console.log('       autoRefreshToken: true,');
  console.log('     })');
  console.log('');
}

main().catch(error => {
  console.error('诊断失败:', error);
  process.exit(1);
});
