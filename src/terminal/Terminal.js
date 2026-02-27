/* ═══════════════════════════════════════════
   NEURODRIVE — Terminal Boot Menu
   Chinese-language CRT terminal interface
   ═══════════════════════════════════════════ */

const ASCII_BANNER = `
  ╔══════════════════════════════════════════════════════════════════╗
  ║                                                                  ║
  ║    ███  神   经   驾   驶   系   统  ███                         ║
  ║                                                                  ║
  ║    ░▒▓  N  E  U  R  O  D  R  I  V  E  ▓▒░                      ║
  ║                                                                  ║
  ║    版本 v2.077  ░░  新上海城市网格  ░░  量子引擎                 ║
  ║                                                                  ║
  ║    ╠═══ 自动驾驶数据采集 ═══╣  ╠═══ 神经网络训练 ═══╣           ║
  ║                                                                  ║
  ╠══════════════════════════════════════════════════════════════════╣
  ║  赛 博 朋 克 ◆ 无 限 城 市 ◆ 全 方 位 驾 驶 ◆ 数 据 链 路     ║
  ╚══════════════════════════════════════════════════════════════════╝
`;

const BOOT_SEQUENCE = [
    { text: '系统初始化中...', delay: 80, cls: '' },
    { text: 'BIOS v4.77 — 量子协处理器已就绪', delay: 60, cls: 'dim' },
    { text: '内存检测: 2048 TB 神经突触 RAM .................. 通过', delay: 40, cls: '' },
    { text: 'GPU 矩阵: NVIDIA ATLAS Ω-9000 .................. 在线', delay: 40, cls: '' },
    { text: '载入神经接口驱动 v7.33 .......................... 完成', delay: 40, cls: '' },
    { text: '连接城市网格 NODE://NEO-SHANGHAI ................ 已连接', delay: 60, cls: 'cyan' },
    { text: '自动驾驶数据链路 ............................... 激活', delay: 40, cls: 'cyan' },
    { text: 'OpenCV 视觉皮层 v5.0 ........................... 在线', delay: 40, cls: '' },
    { text: '语义分割引擎 ................................... 就绪', delay: 40, cls: '' },
    { text: '车辆传感器阵列 ................................. 校准完毕', delay: 40, cls: 'yellow' },
    { text: '', delay: 20, cls: '' },
    { text: '█ 所有系统正常 — 欢迎回来，驾驶员 █', delay: 0, cls: 'bright' },
];

const MENU_ITEMS = [
    { key: '1', label: '[ 1 ] 启动模拟', action: 'start' },
    { key: '2', label: '[ 2 ] 数据导出', action: 'export' },
    { key: '3', label: '[ 3 ] 系统设置', action: 'settings' },
];

export class Terminal {
    constructor(containerEl) {
        this.container = containerEl;
        this.lines = [];
        this.menuVisible = false;
        this.selectedIndex = 0;
        this.onAction = null; // callback
        this._keyHandler = null;
    }

    async show() {
        this.container.style.display = 'flex';
        this.container.innerHTML = '';
        this.lines = [];
        this.menuVisible = false;

        // Render ASCII banner
        await this._renderBanner();
        await this._sleep(400);

        // Boot sequence
        for (const step of BOOT_SEQUENCE) {
            await this._typeLine(step.text, step.cls, step.delay);
        }

        await this._sleep(600);
        this._addLine('');
        this._addLine('══════════════════════════════════════════', 'magenta');
        this._addLine('   请选择操作：', '');
        this._addLine('══════════════════════════════════════════', 'magenta');
        this._addLine('');

        // Render menu
        this._renderMenu();
        this._bindKeys();
    }

    hide() {
        this.container.style.display = 'none';
        this._unbindKeys();
    }

    /* —— internal —— */

    async _renderBanner() {
        const bannerDiv = document.createElement('div');
        bannerDiv.className = 'ascii-art glitch';
        bannerDiv.textContent = ASCII_BANNER;
        this.container.appendChild(bannerDiv);

        const subtitle = document.createElement('div');
        subtitle.className = 'term-line cyan';
        subtitle.textContent = '        神 经 驾 驶  —  自 动 驾 驶 数 据 采 集 平 台  v2.077';
        this.container.appendChild(subtitle);

        this._addLine('');
    }

    async _typeLine(text, cls = '', charDelay = 30) {
        const div = document.createElement('div');
        div.className = `term-line ${cls}`;
        this.container.appendChild(div);
        this.lines.push(div);

        if (charDelay <= 0) {
            div.textContent = text;
        } else {
            // type character by character
            for (let i = 0; i < text.length; i++) {
                div.textContent += text[i];
                if (i % 3 === 0) {
                    await this._sleep(charDelay);
                }
            }
        }
        this._scrollToBottom();
        return div;
    }

    _addLine(text, cls = '') {
        const div = document.createElement('div');
        div.className = `term-line ${cls}`;
        div.textContent = text;
        this.container.appendChild(div);
        this.lines.push(div);
        this._scrollToBottom();
        return div;
    }

    _renderMenu() {
        this.menuEls = [];
        for (let i = 0; i < MENU_ITEMS.length; i++) {
            const item = MENU_ITEMS[i];
            const div = document.createElement('div');
            div.className = 'term-line menu-item';
            div.textContent = '   ' + item.label;
            if (i === this.selectedIndex) div.classList.add('selected');
            this.container.appendChild(div);
            this.menuEls.push(div);

            div.addEventListener('click', () => {
                this._selectItem(i);
                this._activateItem();
            });
        }
        this.menuVisible = true;

        // Blinking cursor at the end
        this._addLine('');
        const cursorLine = document.createElement('div');
        cursorLine.className = 'term-line';
        cursorLine.innerHTML = '  > <span class="cursor"></span>';
        this.container.appendChild(cursorLine);
        this._scrollToBottom();
    }

    _selectItem(index) {
        this.selectedIndex = Math.max(0, Math.min(index, MENU_ITEMS.length - 1));
        this.menuEls.forEach((el, i) => {
            el.classList.toggle('selected', i === this.selectedIndex);
        });
    }

    _activateItem() {
        const action = MENU_ITEMS[this.selectedIndex].action;
        if (this.onAction) this.onAction(action);
    }

    _bindKeys() {
        this._keyHandler = (e) => {
            if (!this.menuVisible) return;

            if (e.key === 'ArrowUp' || e.key === 'w' || e.key === 'W') {
                e.preventDefault();
                this._selectItem(this.selectedIndex - 1);
            } else if (e.key === 'ArrowDown' || e.key === 's' || e.key === 'S') {
                e.preventDefault();
                this._selectItem(this.selectedIndex + 1);
            } else if (e.key === 'Enter') {
                e.preventDefault();
                this._activateItem();
            } else if (e.key === '1' || e.key === '2' || e.key === '3') {
                e.preventDefault();
                const idx = parseInt(e.key) - 1;
                this._selectItem(idx);
                this._activateItem();
            }
        };
        window.addEventListener('keydown', this._keyHandler);
    }

    _unbindKeys() {
        if (this._keyHandler) {
            window.removeEventListener('keydown', this._keyHandler);
            this._keyHandler = null;
        }
    }

    _scrollToBottom() {
        this.container.scrollTop = this.container.scrollHeight;
    }

    _sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}
