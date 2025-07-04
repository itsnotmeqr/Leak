const puppeteer = require('puppeteer');
const puppeteerExtra = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteerExtra.use(StealthPlugin());
const axios = require('axios');
const { URL } = require('url');
const fs = require('fs').promises;

const TARGET_URL = 'https://bnsvip.net';
const CAPMONSTER_API_KEY = '22708881f7f6c0a84f3666fc2e9556ba';
const COOKIE_FILE_PATH = 'cookies.json';
const CAPMONSTER_CREATE_TASK_URL = 'https://api.capmonster.cloud/createTask';
const CAPMONSTER_GET_RESULT_URL = 'https://api.capmonster.cloud/getTaskResult';
const PROXY_STRING = '103.245.237.189:7979:gmpowc:brohpskg';
const [proxyAddress, proxyPort, proxyLogin, proxyPassword] = PROXY_STRING.split(':');

async function createCapMonsterTask(taskPayload) {
    try {
        const response = await axios.post(CAPMONSTER_CREATE_TASK_URL, {
            clientKey: CAPMONSTER_API_KEY,
            task: taskPayload
        });

        if (response.data.errorId === 0) {
            return response.data.taskId;
        } else {
            throw new Error(`CapMonster create task failed: ${response.data.errorCode || 'UNKNOWN_ERROR'} - ${response.data.errorDescription || 'No description provided'}`);
        }
    } catch (error) {
        if (error.response) {
            throw new Error(`CapMonster API error: ${error.response.status} - ${error.response.statusText}`);
        }
        throw error;
    }
}

async function getCapMonsterTaskResult(taskId) {
    const MAX_POLLING_ATTEMPTS = 60;
    const POLLING_INTERVAL_MS = 5000;
    const startTime = Date.now();

    for (let i = 0; i < MAX_POLLING_ATTEMPTS; i++) {
        try {
            const response = await axios.post(CAPMONSTER_GET_RESULT_URL, {
                clientKey: CAPMONSTER_API_KEY,
                taskId: taskId
            });

            if (response.data.errorId !== 0) {
                if (response.data.errorCode === 'ERROR_CAPTCHA_UNSOLVABLE') {
                    console.log(`▪︎ ID: ${taskId}, giải mã thất bại: ${response.data.errorDescription || 'Không có mô tả lỗi.'}.`);
                    throw new Error('Giải mã captcha thất bại.');
                } else {
                    throw new Error(`CapMonster get task result failed: ${response.data.errorCode || 'UNKNOWN_ERROR'} - ${response.data.errorDescription || 'No description provided'}`);
                }
            } else {
                if (response.data.status === 'processing') {
                    await new Promise(resolve => setTimeout(resolve, POLLING_INTERVAL_MS));
                } else if (response.data.status === 'ready') {
                    const endTime = Date.now();
                    const durationSeconds = ((endTime - startTime) / 1000).toFixed(1);
                    return { solution: response.data.solution, duration: durationSeconds };
                } else {
                    throw new Error(`CapMonster task unexpected status: ${response.data.status}`);
                }
            }
        } catch (error) {
            if (error.response) {
                console.warn(`▪︎ Network error during polling attempt ${i + 1}:`, error.response.status);
                if (i === MAX_POLLING_ATTEMPTS - 1) {
                    throw new Error(`Network error after ${MAX_POLLING_ATTEMPTS} attempts: ${error.response.status}`);
                }
                await new Promise(resolve => setTimeout(resolve, POLLING_INTERVAL_MS));
                continue;
            }
            throw error;
        }
    }
    throw new Error(`CapMonster task ${taskId} timeout after ${MAX_POLLING_ATTEMPTS} attempts.`);
}

async function saveCookies(cookies) {
    try {
        await fs.writeFile(COOKIE_FILE_PATH, JSON.stringify(cookies, null, 2));
        console.log('▪︎ Lưu cookie thành công.');
    } catch (error) {
        console.error(`▪︎ Lỗi khi lưu cookie: ${error.message}`);
    }
}

async function loadCookies() {
    try {
        const data = await fs.readFile(COOKIE_FILE_PATH, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') {
            console.log('▪︎ Không tìm thấy file cookie, bắt đầu lấy cookie mới.');
        } else {
            console.error(`▪︎ Lỗi khi tải cookie: ${error.message}`);
        }
        return null;
    }
}

async function handleCloudflareChallenge(page, customUserAgent, targetHostUrl) {
    let turnstileSitekey = null;
    let sitekeyFoundViaRequest = false;
    const currentChallengeUrl = page.url();

    const sitekeyRequestPromise = new Promise((resolve, reject) => {
        const requestListener = request => {
            const reqUrl = request.url();
            const turnstileUrlPattern = /https:\/\/challenges\.cloudflare\.com\/cdn-cgi\/challenge-platform\/h\/[a-zA-Z]\/turnstile\/[a-zA-Z0-9\/]+\/(0x[a-zA-Z0-9]+)\//;
            const match = reqUrl.match(turnstileUrlPattern);

            if (match && match[1]) {
                turnstileSitekey = match[1];
                sitekeyFoundViaRequest = true;
                page.off('request', requestListener);
                resolve(match[1]);
            }
        };
        page.on('request', requestListener);

        setTimeout(() => {
            if (!sitekeyFoundViaRequest) {
                page.off('request', requestListener);
                reject(new Error('Timeout waiting for Turnstile Sitekey from network requests.'));
            }
        }, 60000);
    });

    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });

    try {
        turnstileSitekey = await Promise.race([
            sitekeyRequestPromise,
            new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout waiting for Turnstile Sitekey from network requests.')), 60000))
        ]);
    } catch (error) {
        throw new Error(`Đã xảy ra lỗi khi tìm Sitekey: ${error.message}`);
    }

    if (!turnstileSitekey) {
        throw new Error("Không thể tìm thấy Turnstile Sitekey từ network requests.");
    }

    console.log(`▪︎ Tìm thấy SiteKey, Proxy, User-Agent, HtmlPageBase64.`);
    const htmlContent = await page.evaluate(() => document.documentElement.outerHTML);
    const htmlPageBase64 = Buffer.from(htmlContent).toString('base64');

    const turnstileTaskPayload = {
        type: 'TurnstileTask',
        websiteURL: currentChallengeUrl,
        websiteKey: turnstileSitekey,
        cloudflareTaskType: 'cf_clearance',
        htmlPageBase64: htmlPageBase64,
        userAgent: customUserAgent,
        proxyType: 'http',
        proxyAddress: proxyAddress,
        proxyPort: parseInt(proxyPort),
        proxyLogin: proxyLogin,
        proxyPassword: proxyPassword
    };

    const taskId = await createCapMonsterTask(turnstileTaskPayload);
    console.log(`▪︎ Tạo ID ${taskId} thành công.`);
    const result = await getCapMonsterTaskResult(taskId);
    const capmonsterSolution = result.solution;
    const solutionDuration = result.duration;
    let cfClearanceCookieValue = null;

    if (capmonsterSolution && capmonsterSolution.cf_clearance) {
        cfClearanceCookieValue = capmonsterSolution.cf_clearance;
    } else if (capmonsterSolution && capmonsterSolution.cookies) {
        const foundCookie = capmonsterSolution.cookies.find(c => c.name === 'cf_clearance');
        if (foundCookie) { cfClearanceCookieValue = foundCookie.value; }
    }

    if (cfClearanceCookieValue) {
        console.log(`▪︎ Giải mã thành công (${solutionDuration}s): ${cfClearanceCookieValue.substring(0, 30)}.`);
        
        const targetUrl = new URL(targetHostUrl);
        await page.setCookie({
            name: 'cf_clearance',
            value: cfClearanceCookieValue,
            domain: targetUrl.hostname,
            path: '/',
            expires: Date.now() / 1000 + 3600
        });
        await page.goto(currentChallengeUrl, { waitUntil: 'networkidle0', timeout: 60000 });
        console.log(`▪︎ Tiêu đề sau giải mã: ${await page.title()}.`);
        return true;
    } else {
        throw new Error("Không giải được challenge. Không tìm thấy cookie cf_clearance trong giải pháp.");
    }
}

async function ensurePageReady(page, customUserAgent, targetHostUrl, maxRetries = 3) {
    for (let i = 0; i < maxRetries; i++) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        let currentPageTitle;
        try {
            currentPageTitle = await page.title();
        } catch (error) {
            console.warn(`▪︎ Không thể lấy tiêu đề trang: ${error.message}`);
            currentPageTitle = '';
        }
        
        const currentUrl = page.url();

        if (currentPageTitle === 'Just a moment...') {
            console.log(`▪︎ [${i + 1}/${maxRetries}] Phát hiện Cloudflare Challenge tại: ${currentUrl}, bắt đầu giải mã.`);
            try {
                await handleCloudflareChallenge(page, customUserAgent, targetHostUrl);
                
                let newPageTitle;
                try {
                    newPageTitle = await page.title();
                } catch (error) {
                    console.warn(`▪︎ Không thể lấy tiêu đề trang sau challenge: ${error.message}`);
                    newPageTitle = '';
                }
                
                if (newPageTitle !== 'Just a moment...') {
                    console.log('▪︎ Đã vượt qua Cloudflare Challenge.');
                    return true;
                } else {
                    console.log('▪︎ Đã giải mã nhưng vẫn bị kẹt trên trang Cloudflare Challenge, thử lại.');
                }
            } catch (challengeError) {
                console.error(`▪︎ Lỗi khi giải mã Cloudflare Challenge: ${challengeError.message}, thử lại.`);
            }
        } else {
            return true;
        }
    }
    throw new Error(`Thất bại khi vượt Cloudflare Challenge sau ${maxRetries} lần thử.`);
}

(async () => {
    let browser;
    try {
        console.log('▪︎ Đang mở trình duyệt và truy cập trang chủ.');
        browser = await puppeteerExtra.launch({
            executablePath: '/usr/bin/chromium',
            headless: "new",
            args: [
                `--proxy-server=http://${proxyAddress}:${proxyPort}`,
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-gpu',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--single-process',
                '--disable-features=site-per-process',
                '--disable-features=IsolateOrigins,site-per-process',
                '--window-size=1920,1080',
                '--lang=en'
            ]
        });

        const page = await browser.newPage();
        await page.authenticate({
            username: proxyLogin,
            password: proxyPassword
        });

        const customUserAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';
        await page.setUserAgent(customUserAgent);

        let cookiesLoadedSuccessfully = false;
        const savedCookies = await loadCookies();

        if (savedCookies) {
            try {
                await page.setCookie(...savedCookies);
                await page.goto(TARGET_URL, {
                    waitUntil: 'networkidle0',
                    timeout: 60000
                });

                await ensurePageReady(page, customUserAgent, TARGET_URL);

                let pageTitle;
                let isLoggedIn;
                
                try {
                    pageTitle = await page.title();
                    isLoggedIn = await page.evaluate(() => {
                        return document.body && document.body.innerText.includes('Điều khoản dịch vụ');
                    });
                } catch (error) {
                    console.warn(`▪︎ Lỗi khi kiểm tra trạng thái đăng nhập: ${error.message}`);
                    pageTitle = '';
                    isLoggedIn = false;
                }

                if (isLoggedIn && pageTitle !== 'Just a moment...') {
                    console.log('▪︎ Cookie còn hoạt động, đang dùng để đăng nhập.');
                    console.log('▪︎ Tìm thấy Điều khoản dịch vụ, đăng nhập thành công.');
                    cookiesLoadedSuccessfully = true;
                } else {
                    console.log('▪︎ Cookie đã hết hạn, bắt đầu lấy cookie mới.');
                }
            } catch (error) {
                console.error(`▪︎ Lỗi khi sử dụng cookie đã lưu hoặc giải mã lại: ${error.message}.`);
                cookiesLoadedSuccessfully = false;
            }
        }

        if (!cookiesLoadedSuccessfully) {
            console.log('▪︎ Đang bắt đầu lấy cookie mới.');
            await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
            await ensurePageReady(page, customUserAgent, TARGET_URL);

            console.log('▪︎ Bắt đầu đăng nhập');
            await page.goto('https://bnsvip.net/dang-nhap?redirect=/', { waitUntil: 'domcontentloaded', timeout: 60000 });
            await ensurePageReady(page, customUserAgent, TARGET_URL);

            try {
                await page.waitForSelector('input[name="username"]', { visible: true, timeout: 30000 });
                await page.type('input[name="username"]', 'itsnotmeqr@gmail.com');
                await page.waitForSelector('input[name="password"]', { visible: true, timeout: 30000 });
                await page.type('input[name="password"]', 'Djagja12@@!');
                
                await Promise.all([
                    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(e => {
                        console.warn(`▪︎ Điều hướng sau khi đăng nhập không thành công: ${e.message}.`);
                        return null;
                    }),
                    page.click('button[type="submit"]')
                ]);
            } catch (error) {
                console.error(`▪︎ Lỗi khi điền form đăng nhập: ${error.message}`);
                throw error;
            }

            await ensurePageReady(page, customUserAgent, TARGET_URL);

            let isLoggedInAfterAllChecks;
            try {
                isLoggedInAfterAllChecks = await page.evaluate(() => {
                    return document.body && document.body.innerText.includes('Điều khoản dịch vụ');
                });
            } catch (error) {
                console.warn(`▪︎ Lỗi khi kiểm tra trạng thái đăng nhập sau khi submit: ${error.message}`);
                isLoggedInAfterAllChecks = false;
            }

            if (isLoggedInAfterAllChecks) {
                console.log('▪︎ Tìm thấy Điều khoản dịch vụ, đăng nhập thành công.');
                const currentCookies = await page.cookies();
                await saveCookies(currentCookies);
            } else {
                console.log('▪︎ Đăng nhập không thành công sau tất cả các bước giải mã và thử lại. Vui lòng kiểm tra lại thông tin đăng nhập hoặc trang web.');
            }
        }

    } catch (error) {
        console.error(`\nĐÃ XẢY RA LỖI NGHIÊM TRỌNG: ${error.message}`);
        console.error('Stack trace:', error.stack);
    } finally {
        if (browser) {
            await browser.close();
        }
    }
})();