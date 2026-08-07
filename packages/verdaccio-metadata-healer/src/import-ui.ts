/**
 * Import Web UI HTML 模板
 * 提供简单的管理界面用于导入差分包
 */

export function getImportUIHTML(config: any): string {
  const title = config?.title || 'Verdaccio Metadata Healer';

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} - 导入管理</title>
  <style>
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
      background: #f5f5f5;
      color: #333;
      line-height: 1.6;
    }

    .container {
      max-width: 900px;
      margin: 0 auto;
      padding: 20px;
    }

    header {
      background: linear-gradient(135deg, #28a745 0%, #1e7e34 100%);
      color: white;
      padding: 20px;
      margin-bottom: 20px;
      border-radius: 8px;
      box-shadow: 0 2px 10px rgba(0,0,0,0.1);
    }

    header h1 {
      font-size: 24px;
      margin-bottom: 5px;
    }

    header p {
      opacity: 0.9;
      font-size: 14px;
    }

    .card {
      background: white;
      border-radius: 8px;
      padding: 20px;
      margin-bottom: 20px;
      box-shadow: 0 2px 10px rgba(0,0,0,0.05);
    }

    .card h2 {
      font-size: 18px;
      margin-bottom: 15px;
      padding-bottom: 10px;
      border-bottom: 2px solid #28a745;
      color: #1e7e34;
    }

    .upload-area {
      border: 2px dashed #ccc;
      border-radius: 8px;
      padding: 40px;
      text-align: center;
      cursor: pointer;
      transition: all 0.3s;
      margin-bottom: 15px;
    }

    .upload-area:hover {
      border-color: #28a745;
      background: #f8fff8;
    }

    .upload-area.dragover {
      border-color: #28a745;
      background: #e8f5e9;
    }

    .upload-area.has-file {
      border-color: #28a745;
      background: #e8f5e9;
    }

    .upload-icon {
      font-size: 48px;
      margin-bottom: 10px;
    }

    .upload-text {
      color: #666;
      margin-bottom: 10px;
    }

    .upload-hint {
      font-size: 12px;
      color: #999;
    }

    .file-info {
      display: none;
      padding: 15px;
      background: #f8f9fa;
      border-radius: 6px;
      margin-bottom: 15px;
    }

    .file-info.visible {
      display: block;
    }

    .file-name {
      font-weight: 600;
      color: #28a745;
    }

    .file-size {
      color: #666;
      font-size: 14px;
    }

    .btn {
      display: inline-block;
      padding: 10px 20px;
      border: none;
      border-radius: 5px;
      cursor: pointer;
      font-size: 14px;
      font-weight: 500;
      transition: all 0.3s;
      margin: 5px;
    }

    .btn-primary {
      background: #28a745;
      color: white;
    }

    .btn-primary:hover {
      background: #218838;
    }

    .btn-danger {
      background: #dc3545;
      color: white;
    }

    .btn-danger:hover {
      background: #c82333;
    }

    .btn:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }

    .form-group {
      margin-bottom: 15px;
    }

    .form-group label {
      display: block;
      margin-bottom: 5px;
      font-weight: 500;
      color: #555;
    }

    .option-row {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 14px;
      background: #f8f9fa;
      border-radius: 6px;
      border: 1px solid #e9ecef;
      margin-bottom: 10px;
    }

    .option-row:hover {
      background: #e9ecef;
    }

    .option-row label {
      flex: 1;
      display: flex;
      align-items: center;
      gap: 8px;
      cursor: pointer;
      font-weight: normal;
    }

    .help-btn {
      width: 20px;
      height: 20px;
      border-radius: 50%;
      background: #6c757d;
      color: white;
      border: none;
      cursor: pointer;
      font-size: 12px;
      font-weight: bold;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      position: relative;
    }

    .help-btn:hover {
      background: #28a745;
    }

    .tooltip {
      position: absolute;
      bottom: 100%;
      left: 50%;
      transform: translateX(-50%);
      background: #333;
      color: white;
      padding: 8px 12px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: normal;
      min-width: 200px;
      max-width: 400px;
      white-space: normal;
      text-align: left;
      z-index: 1000;
      margin-bottom: 8px;
      box-shadow: 0 2px 10px rgba(0,0,0,0.2);
      display: none;
    }

    .tooltip::after {
      content: '';
      position: absolute;
      top: 100%;
      left: 50%;
      transform: translateX(-50%);
      border: 6px solid transparent;
      border-top-color: #333;
    }

    .help-btn:hover .tooltip {
      display: block;
    }

    .progress-container {
      display: none;
      margin-top: 20px;
    }

    .progress-container.visible {
      display: block;
    }

    .progress-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 10px;
    }

    .progress-phase {
      font-weight: 600;
      color: #1e7e34;
    }

    .progress-percentage {
      font-size: 24px;
      font-weight: bold;
      color: #28a745;
    }

    .progress-bar {
      height: 12px;
      background: #e0e0e0;
      border-radius: 6px;
      overflow: hidden;
      margin-bottom: 10px;
    }

    .progress-bar-fill {
      height: 100%;
      background: linear-gradient(90deg, #28a745, #20c997);
      transition: width 0.3s;
    }

    .progress-message {
      font-size: 13px;
      color: #666;
      padding: 8px 12px;
      background: #f8f9fa;
      border-radius: 5px;
    }

    .result-container {
      display: none;
      margin-top: 20px;
      padding: 20px;
      border-radius: 8px;
    }

    .result-container.visible {
      display: block;
    }

    .result-container.success {
      background: #e8f5e9;
      border: 1px solid #c8e6c9;
    }

    .result-container.error {
      background: #ffebee;
      border: 1px solid #ffcdd2;
    }

    .result-icon {
      font-size: 48px;
      text-align: center;
      margin-bottom: 10px;
    }

    .result-title {
      text-align: center;
      font-size: 18px;
      font-weight: 600;
      margin-bottom: 15px;
    }

    .result-stats {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 15px;
      margin-bottom: 15px;
    }

    .result-stat {
      text-align: center;
      padding: 10px;
      background: white;
      border-radius: 6px;
    }

    .result-stat-value {
      font-size: 24px;
      font-weight: bold;
      color: #28a745;
    }

    .result-stat-label {
      font-size: 12px;
      color: #666;
    }

    .history-list {
      max-height: 300px;
      overflow-y: auto;
    }

    .history-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 12px;
      border-bottom: 1px solid #eee;
    }

    .history-item:last-child {
      border-bottom: none;
    }

    .history-item:hover {
      background: #f8f9fa;
    }

    .history-name {
      font-weight: 500;
    }

    .history-info {
      font-size: 12px;
      color: #666;
    }

    .status-badge {
      display: inline-block;
      padding: 3px 10px;
      border-radius: 20px;
      font-size: 12px;
      font-weight: 500;
    }

    .status-badge.success { background: #e8f5e9; color: #388e3c; }
    .status-badge.partial { background: #fff3e0; color: #f57c00; }
    .status-badge.failed { background: #ffebee; color: #d32f2f; }

    .log-container {
      background: #1e1e1e;
      color: #d4d4d4;
      border-radius: 5px;
      padding: 15px;
      font-family: 'Consolas', 'Monaco', monospace;
      font-size: 13px;
      max-height: 200px;
      overflow-y: auto;
    }

    .log-entry {
      margin-bottom: 5px;
      padding: 3px 0;
      border-bottom: 1px solid #333;
    }

    .log-entry.info { color: #4fc3f7; }
    .log-entry.success { color: #81c784; }
    .log-entry.warning { color: #ffb74d; }
    .log-entry.error { color: #e57373; }

    .log-time {
      color: #888;
      margin-right: 10px;
    }

    #fileInput {
      display: none;
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>📥 ${title}</h1>
      <p>离线 NPM 依赖管理 - 内网导入控制台</p>
    </header>

    <!-- 文件上传 -->
    <div class="card">
      <h2>📦 导入差分包</h2>
      <div class="upload-area" id="uploadArea" onclick="document.getElementById('fileInput').click()">
        <div class="upload-icon">📁</div>
        <div class="upload-text">点击或拖拽文件到此处</div>
        <div class="upload-hint">支持 .tar.gz 格式的差分导出包</div>
      </div>
      <input type="file" id="fileInput" accept=".tar.gz,.tgz">

      <div class="file-info" id="fileInfo">
        <span class="file-name" id="fileName"></span>
        <span class="file-size" id="fileSize"></span>
        <button class="btn btn-danger" onclick="clearFile()" style="float: right; padding: 5px 10px;">✕ 移除</button>
      </div>

      <div class="form-group">
        <label>导入选项</label>
        <div class="option-row">
          <label><input type="checkbox" id="overwrite"><span>覆盖已存在的文件</span></label>
          <button class="help-btn" type="button">?<span class="tooltip">如果目标文件已存在，是否覆盖。默认跳过已存在的文件。</span></button>
        </div>
        <div class="option-row">
          <label><input type="checkbox" id="validateChecksum" checked><span>验证文件校验和</span></label>
          <button class="help-btn" type="button">?<span class="tooltip">导入前验证每个文件的 SHA256 校验和，确保文件完整性。</span></button>
        </div>
        <div class="option-row">
          <label><input type="checkbox" id="rebuildMetadata" checked><span>自动重建元数据</span></label>
          <button class="help-btn" type="button">?<span class="tooltip">导入后自动触发元数据重建，使新导入的包立即可用。</span></button>
        </div>
      </div>

      <button class="btn btn-primary" id="importBtn" onclick="startImport()" disabled>
        🚀 开始导入
      </button>

      <!-- 进度显示 -->
      <div class="progress-container" id="progressContainer">
        <div class="progress-header">
          <span class="progress-phase" id="progressPhase">准备中...</span>
          <span class="progress-percentage" id="progressPercentage">0%</span>
        </div>
        <div class="progress-bar">
          <div class="progress-bar-fill" id="progressBar" style="width: 0%"></div>
        </div>
        <div class="progress-message" id="progressMessage">等待开始...</div>
      </div>

      <!-- 结果显示 -->
      <div class="result-container" id="resultContainer">
        <div class="result-icon" id="resultIcon">✅</div>
        <div class="result-title" id="resultTitle">导入完成</div>
        <div class="result-stats" id="resultStats"></div>
        <div style="text-align: center;">
          <button class="btn btn-primary" onclick="resetImport()">↩️ 继续导入</button>
        </div>
      </div>
    </div>

    <!-- 本地路径导入 -->
    <div class="card">
      <h2>📂 从服务器本地路径导入</h2>
      <p style="color: #666; margin-bottom: 15px;">适用于通过 SSH/SCP 预先上传到服务器的差分包，无需通过浏览器上传</p>

      <div class="form-group">
        <label>文件路径</label>
        <div style="display: flex; gap: 10px;">
          <input type="text" id="localPathInput" placeholder="输入服务器上的文件绝对路径，如 /tmp/export-2024.tar.gz"
            style="flex: 1; padding: 10px; border: 1px solid #ddd; border-radius: 5px; font-size: 14px;">
        </div>
      </div>

      <div class="form-group">
        <label>导入选项</label>
        <div class="option-row">
          <label><input type="checkbox" id="localOverwrite"><span>覆盖已存在的文件</span></label>
        </div>
        <div class="option-row">
          <label><input type="checkbox" id="localValidateChecksum" checked><span>验证文件校验和</span></label>
        </div>
        <div class="option-row">
          <label><input type="checkbox" id="localRebuildMetadata" checked><span>自动重建元数据</span></label>
        </div>
      </div>

      <button class="btn btn-primary" id="localImportBtn" onclick="startLocalImport()">
        🚀 从本地路径导入
      </button>

      <!-- 本地导入进度 -->
      <div class="progress-container" id="localProgressContainer">
        <div class="progress-header">
          <span class="progress-phase" id="localProgressPhase">准备中...</span>
          <span class="progress-percentage" id="localProgressPercentage">0%</span>
        </div>
        <div class="progress-bar">
          <div class="progress-bar-fill" id="localProgressBar" style="width: 0%"></div>
        </div>
        <div class="progress-message" id="localProgressMessage">等待开始...</div>
      </div>

      <!-- 本地导入结果 -->
      <div class="result-container" id="localResultContainer">
        <div class="result-icon" id="localResultIcon">✅</div>
        <div class="result-title" id="localResultTitle">导入完成</div>
        <div class="result-stats" id="localResultStats"></div>
        <div style="text-align: center;">
          <button class="btn btn-primary" onclick="resetLocalImport()">↩️ 继续导入</button>
        </div>
      </div>
    </div>

    <!-- 本地缓存索引重建 -->
    <div class="card">
      <h2>🔄 重建本地缓存索引</h2>
      <p style="color: #666; margin-bottom: 15px;">
        完全离线扫描 storage 中现有的包与 tarball，重建 package.json、latest 标签和本地包列表。
        适用于修复此前已经导入或下载、但尚未真正可用的缓存包，可重复执行。
      </p>

      <button class="btn btn-primary" id="rebuildIndexBtn" onclick="startRebuildIndex()">
        🔧 开始重建本地缓存索引
      </button>

      <div class="progress-container" id="rebuildProgressContainer">
        <div class="progress-header">
          <span class="progress-phase" id="rebuildProgressPhase">准备中...</span>
          <span class="progress-percentage" id="rebuildProgressPercentage">0%</span>
        </div>
        <div class="progress-bar">
          <div class="progress-bar-fill" id="rebuildProgressBar" style="width: 0%"></div>
        </div>
        <div class="progress-message" id="rebuildProgressMessage">等待开始...</div>
      </div>

      <div class="result-container" id="rebuildResultContainer">
        <div class="result-icon" id="rebuildResultIcon">✅</div>
        <div class="result-title" id="rebuildResultTitle">重建完成</div>
        <div class="result-stats" id="rebuildResultStats"></div>
        <div id="rebuildResultError" style="color: #d32f2f; text-align: center; margin-bottom: 15px;"></div>
        <div style="text-align: center;">
          <button class="btn btn-primary" onclick="resetRebuildIndex()">↩️ 再次重建</button>
        </div>
      </div>
    </div>

    <!-- 导入历史 -->
    <div class="card">
      <h2>📜 导入历史</h2>
      <div class="history-list" id="historyList">
        <p style="color: #666; text-align: center; padding: 20px;">加载中...</p>
      </div>
    </div>

    <!-- 执行日志 -->
    <div class="card">
      <h2>📋 执行日志</h2>
      <div class="log-container" id="logContainer">
        <div class="log-entry info">
          <span class="log-time">[${new Date().toLocaleTimeString()}]</span>
          系统就绪，等待上传文件...
        </div>
      </div>
    </div>
  </div>

  <script>
    const API_BASE = '/_/healer/import';
    let selectedFile = null;
    let currentTaskId = null;
    let pollInterval = null;
    let rebuildPollInterval = null;

    // 添加日志
    function addLog(message, type = 'info') {
      const container = document.getElementById('logContainer');
      const time = new Date().toLocaleTimeString();
      const entry = document.createElement('div');
      entry.className = 'log-entry ' + type;
      entry.innerHTML = '<span class="log-time">[' + time + ']</span>' + message;
      container.appendChild(entry);
      container.scrollTop = container.scrollHeight;
    }

    // 格式化文件大小
    function formatSize(bytes) {
      if (bytes < 1024) return bytes + ' B';
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
      if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
      return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
    }

    // 文件选择处理
    document.getElementById('fileInput').addEventListener('change', function(e) {
      if (e.target.files.length > 0) {
        selectFile(e.target.files[0]);
      }
    });

    // 拖拽处理
    const uploadArea = document.getElementById('uploadArea');

    uploadArea.addEventListener('dragover', function(e) {
      e.preventDefault();
      this.classList.add('dragover');
    });

    uploadArea.addEventListener('dragleave', function(e) {
      e.preventDefault();
      this.classList.remove('dragover');
    });

    uploadArea.addEventListener('drop', function(e) {
      e.preventDefault();
      this.classList.remove('dragover');
      if (e.dataTransfer.files.length > 0) {
        selectFile(e.dataTransfer.files[0]);
      }
    });

    // 选择文件
    function selectFile(file) {
      if (!file.name.endsWith('.tar.gz') && !file.name.endsWith('.tgz')) {
        addLog('只支持 .tar.gz 或 .tgz 文件', 'error');
        return;
      }

      selectedFile = file;
      document.getElementById('fileName').textContent = file.name;
      document.getElementById('fileSize').textContent = ' (' + formatSize(file.size) + ')';
      document.getElementById('fileInfo').classList.add('visible');
      document.getElementById('uploadArea').classList.add('has-file');
      document.getElementById('importBtn').disabled = false;
      addLog('已选择文件: ' + file.name, 'success');
    }

    // 清除文件
    function clearFile() {
      selectedFile = null;
      document.getElementById('fileInput').value = '';
      document.getElementById('fileInfo').classList.remove('visible');
      document.getElementById('uploadArea').classList.remove('has-file');
      document.getElementById('importBtn').disabled = true;
    }

    // 开始导入
    async function startImport() {
      if (!selectedFile) {
        addLog('请先选择文件', 'warning');
        return;
      }

      const formData = new FormData();
      formData.append('file', selectedFile);
      formData.append('overwrite', document.getElementById('overwrite').checked);
      formData.append('validateChecksum', document.getElementById('validateChecksum').checked);
      formData.append('rebuildMetadata', document.getElementById('rebuildMetadata').checked);

      try {
        document.getElementById('importBtn').disabled = true;
        document.getElementById('progressContainer').classList.add('visible');
        document.getElementById('resultContainer').classList.remove('visible');
        addLog('正在上传文件...', 'info');

        const response = await fetch(API_BASE + '/upload', {
          method: 'POST',
          body: formData
        });
        const data = await response.json();

        if (data.success && data.taskId) {
          currentTaskId = data.taskId;
          addLog('导入任务已启动: ' + data.taskId, 'success');
          startPolling(data.taskId);
        } else {
          addLog('启动导入失败: ' + (data.error || '未知错误'), 'error');
          document.getElementById('importBtn').disabled = false;
        }
      } catch (error) {
        addLog('上传失败: ' + error.message, 'error');
        document.getElementById('importBtn').disabled = false;
      }
    }

    // 本地路径导入
    let localPollInterval = null;

    async function startLocalImport() {
      const localPath = document.getElementById('localPathInput').value.trim();
      if (!localPath) {
        addLog('请输入文件路径', 'warning');
        return;
      }

      if (!localPath.endsWith('.tar.gz') && !localPath.endsWith('.tgz')) {
        addLog('只支持 .tar.gz 或 .tgz 文件', 'warning');
        return;
      }

      try {
        document.getElementById('localImportBtn').disabled = true;
        document.getElementById('localProgressContainer').classList.add('visible');
        document.getElementById('localResultContainer').classList.remove('visible');
        addLog('正在从本地路径导入: ' + localPath, 'info');

        const response = await fetch(API_BASE + '/local', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            path: localPath,
            overwrite: document.getElementById('localOverwrite').checked,
            validateChecksum: document.getElementById('localValidateChecksum').checked,
            rebuildMetadata: document.getElementById('localRebuildMetadata').checked
          })
        });
        const data = await response.json();

        if (data.success && data.taskId) {
          addLog('导入任务已启动: ' + data.taskId, 'success');
          startLocalPolling(data.taskId);
        } else {
          addLog('启动导入失败: ' + (data.error || '未知错误'), 'error');
          document.getElementById('localImportBtn').disabled = false;
        }
      } catch (error) {
        addLog('本地导入请求失败: ' + error.message, 'error');
        document.getElementById('localImportBtn').disabled = false;
      }
    }

    function startLocalPolling(taskId) {
      if (localPollInterval) {
        clearInterval(localPollInterval);
      }

      localPollInterval = setInterval(async () => {
        try {
          const response = await fetch(API_BASE + '/status/' + taskId);
          const task = await response.json();

          updateLocalProgress(task);

          if (task.status === 'completed' || task.status === 'failed') {
            clearInterval(localPollInterval);
            localPollInterval = null;

            if (task.status === 'completed' && task.result) {
              addLog('本地导入完成: ' + task.result.imported + ' 个文件', 'success');
              showLocalResult(task.result);
              loadHistory();
            } else {
              addLog('本地导入失败: ' + (task.error || '未知错误'), 'error');
              showLocalError(task.error || '未知错误');
            }
            document.getElementById('localImportBtn').disabled = false;
          }
        } catch (error) {
          addLog('查询状态失败: ' + error.message, 'error');
        }
      }, 1000);
    }

    function updateLocalProgress(task) {
      const phase = document.getElementById('localProgressPhase');
      const percentage = document.getElementById('localProgressPercentage');
      const bar = document.getElementById('localProgressBar');
      const message = document.getElementById('localProgressMessage');

      if (task.progress !== undefined) {
        const pct = Math.round(task.progress);
        percentage.textContent = pct + '%';
        bar.style.width = pct + '%';
      }
      if (task.message) {
        message.textContent = task.message;
      }
      if (task.detailedProgress) {
        phase.textContent = task.detailedProgress.phaseDescription || task.detailedProgress.phase || '处理中...';
      }
    }

    function showLocalResult(result) {
      document.getElementById('localProgressContainer').classList.remove('visible');
      document.getElementById('localResultContainer').classList.add('visible');
      document.getElementById('localResultIcon').textContent = '✅';
      document.getElementById('localResultTitle').textContent = '导入完成';
      document.getElementById('localResultStats').innerHTML =
        '<div style="text-align: center; color: #666;">' +
        '导入 ' + result.imported + ' 个文件' +
        (result.skipped ? '，跳过 ' + result.skipped + ' 个' : '') +
        (result.failed ? '，失败 ' + result.failed + ' 个' : '') +
        '</div>';
    }

    function showLocalError(error) {
      document.getElementById('localProgressContainer').classList.remove('visible');
      document.getElementById('localResultContainer').classList.add('visible');
      document.getElementById('localResultIcon').textContent = '❌';
      document.getElementById('localResultTitle').textContent = '导入失败';
      document.getElementById('localResultStats').innerHTML =
        '<div style="text-align: center; color: #e57373;">' + error + '</div>';
    }

    function resetLocalImport() {
      document.getElementById('localProgressContainer').classList.remove('visible');
      document.getElementById('localResultContainer').classList.remove('visible');
      document.getElementById('localPathInput').value = '';
    }

    // 从现有 storage 完全离线重建所有包的元数据和本地包列表
    async function startRebuildIndex() {
      const button = document.getElementById('rebuildIndexBtn');
      button.disabled = true;
      document.getElementById('rebuildProgressContainer').classList.add('visible');
      document.getElementById('rebuildResultContainer').classList.remove('visible');
      document.getElementById('rebuildProgressPhase').textContent = '扫描本地缓存';
      document.getElementById('rebuildProgressPercentage').textContent = '0%';
      document.getElementById('rebuildProgressBar').style.width = '0%';
      document.getElementById('rebuildProgressMessage').textContent = '正在扫描 storage 中的包目录...';
      addLog('开始扫描并重建本地缓存索引（不会访问上游）...', 'info');

      try {
        const response = await fetch('/_/healer/rebuild-index', { method: 'POST' });
        const data = await response.json();

        if (data.taskId && (data.success || response.status === 409)) {
          addLog(
            response.status === 409
              ? '已有重建任务正在运行，继续显示其进度: ' + data.taskId
              : '本地缓存重建任务已启动: ' + data.taskId,
            response.status === 409 ? 'warning' : 'success'
          );
          startRebuildPolling(data.taskId);
          return;
        }

        throw new Error(data.error || '启动重建失败');
      } catch (error) {
        addLog('启动本地缓存重建失败: ' + error.message, 'error');
        showRebuildResult(null, error.message);
        button.disabled = false;
      }
    }

    function startRebuildPolling(taskId) {
      if (rebuildPollInterval) {
        clearInterval(rebuildPollInterval);
      }

      const poll = async () => {
        try {
          const response = await fetch('/_/healer/rebuild/status/' + encodeURIComponent(taskId));
          const task = await response.json();
          if (!response.ok) {
            throw new Error(task.error || '查询重建状态失败');
          }

          updateRebuildProgress(task);
          if (task.status !== 'completed' && task.status !== 'failed') {
            return;
          }

          clearInterval(rebuildPollInterval);
          rebuildPollInterval = null;
          document.getElementById('rebuildIndexBtn').disabled = false;
          showRebuildResult(task.result || null, task.error || '');

          if (task.status === 'completed') {
            addLog('本地缓存索引重建完成，共处理 ' + task.result.scanned + ' 个包', 'success');
          } else {
            addLog('本地缓存索引重建部分失败: ' + (task.error || '未知错误'), 'warning');
          }
        } catch (error) {
          clearInterval(rebuildPollInterval);
          rebuildPollInterval = null;
          document.getElementById('rebuildIndexBtn').disabled = false;
          addLog('查询重建状态失败: ' + error.message, 'error');
          showRebuildResult(null, error.message);
        }
      };

      poll();
      rebuildPollInterval = setInterval(poll, 1000);
    }

    function updateRebuildProgress(task) {
      const pct = Math.max(0, Math.min(100, Math.round(task.progress || 0)));
      document.getElementById('rebuildProgressPhase').textContent =
        task.status === 'pending' ? '等待执行' : '重建本地缓存';
      document.getElementById('rebuildProgressPercentage').textContent = pct + '%';
      document.getElementById('rebuildProgressBar').style.width = pct + '%';
      document.getElementById('rebuildProgressMessage').textContent =
        task.currentPackage
          ? task.currentPackage + ' (' + task.current + '/' + task.total + ')'
          : (task.message || '处理中...');
    }

    function showRebuildResult(result, error) {
      const container = document.getElementById('rebuildResultContainer');
      document.getElementById('rebuildProgressContainer').classList.remove('visible');
      container.classList.add('visible');
      container.classList.remove('success', 'error');
      container.classList.add(error ? 'error' : 'success');
      document.getElementById('rebuildResultIcon').textContent = error ? '⚠️' : '✅';
      document.getElementById('rebuildResultTitle').textContent =
        error ? (result ? '重建完成，部分包失败' : '重建失败') : '重建完成';

      const stats = result || {
        scanned: 0,
        rebuilt: 0,
        skipped: 0,
        failed: 0,
        localVersions: 0,
        healedVersions: 0
      };
      document.getElementById('rebuildResultStats').innerHTML =
        '<div class="result-stat"><div class="result-stat-value">' + stats.scanned + '</div><div class="result-stat-label">扫描包数</div></div>' +
        '<div class="result-stat"><div class="result-stat-value">' + stats.rebuilt + '</div><div class="result-stat-label">已重建</div></div>' +
        '<div class="result-stat"><div class="result-stat-value">' + stats.localVersions + '</div><div class="result-stat-label">本地版本</div></div>' +
        '<div class="result-stat"><div class="result-stat-value">' + stats.healedVersions + '</div><div class="result-stat-label">补全版本</div></div>' +
        '<div class="result-stat"><div class="result-stat-value">' + stats.skipped + '</div><div class="result-stat-label">已跳过</div></div>' +
        '<div class="result-stat"><div class="result-stat-value">' + stats.failed + '</div><div class="result-stat-label">失败</div></div>';
      document.getElementById('rebuildResultError').textContent = error || '';
    }

    function resetRebuildIndex() {
      document.getElementById('rebuildProgressContainer').classList.remove('visible');
      document.getElementById('rebuildResultContainer').classList.remove('visible');
      document.getElementById('rebuildIndexBtn').disabled = false;
    }

    // 开始轮询状态
    function startPolling(taskId) {
      if (pollInterval) {
        clearInterval(pollInterval);
      }

      pollInterval = setInterval(async () => {
        try {
          const response = await fetch(API_BASE + '/status/' + taskId);
          const task = await response.json();

          updateProgress(task);

          if (task.status === 'completed' || task.status === 'failed') {
            clearInterval(pollInterval);
            pollInterval = null;

            if (task.status === 'completed' && task.result) {
              addLog('导入完成: ' + task.result.imported + ' 个文件', 'success');
              showResult(task.result);
              loadHistory();
            } else {
              addLog('导入失败: ' + (task.error || '未知错误'), 'error');
              showError(task.error || '未知错误');
            }
          }
        } catch (error) {
          addLog('获取状态失败: ' + error.message, 'error');
        }
      }, 1000);
    }

    // 更新进度显示
    function updateProgress(task) {
      const progress = task.detailedProgress || {};
      const totalProgress = task.progress || progress.totalProgress || 0;

      const phaseLabels = {
        'uploading': '上传文件',
        'extracting': '解压文件',
        'validating': '验证校验和',
        'importing': '导入文件',
        'rebuilding': '重建元数据',
        'completed': '导入完成'
      };

      document.getElementById('progressPhase').textContent =
        phaseLabels[progress.phase] || progress.phaseDescription || '处理中...';
      document.getElementById('progressPercentage').textContent = totalProgress + '%';
      document.getElementById('progressBar').style.width = totalProgress + '%';
      document.getElementById('progressMessage').textContent =
        progress.currentFile || progress.phaseDescription || task.message || '处理中...';
    }

    // 显示结果
    function showResult(result) {
      document.getElementById('progressContainer').classList.remove('visible');
      document.getElementById('resultContainer').classList.add('visible');
      document.getElementById('resultContainer').classList.remove('error');
      document.getElementById('resultContainer').classList.add('success');

      document.getElementById('resultIcon').textContent = result.success ? '✅' : '⚠️';
      document.getElementById('resultTitle').textContent = result.success ? '导入完成' : '部分导入成功';

      document.getElementById('resultStats').innerHTML =
        '<div class="result-stat">' +
          '<div class="result-stat-value">' + result.imported + '</div>' +
          '<div class="result-stat-label">已导入</div>' +
        '</div>' +
        '<div class="result-stat">' +
          '<div class="result-stat-value">' + result.skipped + '</div>' +
          '<div class="result-stat-label">已跳过</div>' +
        '</div>' +
        '<div class="result-stat">' +
          '<div class="result-stat-value">' + result.packages + '</div>' +
          '<div class="result-stat-label">包数</div>' +
        '</div>' +
        '<div class="result-stat">' +
          '<div class="result-stat-value">' + result.versions + '</div>' +
          '<div class="result-stat-label">版本数</div>' +
        '</div>';
    }

    // 显示错误
    function showError(error) {
      document.getElementById('progressContainer').classList.remove('visible');
      document.getElementById('resultContainer').classList.add('visible');
      document.getElementById('resultContainer').classList.remove('success');
      document.getElementById('resultContainer').classList.add('error');

      document.getElementById('resultIcon').textContent = '❌';
      document.getElementById('resultTitle').textContent = '导入失败';
      document.getElementById('resultStats').innerHTML =
        '<p style="text-align: center; color: #d32f2f;">' + error + '</p>';
    }

    // 重置导入
    function resetImport() {
      clearFile();
      document.getElementById('progressContainer').classList.remove('visible');
      document.getElementById('resultContainer').classList.remove('visible');
      document.getElementById('importBtn').disabled = true;
      currentTaskId = null;
    }

    // 加载导入历史
    async function loadHistory() {
      try {
        const response = await fetch(API_BASE + '/history');
        const data = await response.json();

        const container = document.getElementById('historyList');
        if (!data.history || data.history.length === 0) {
          container.innerHTML = '<p style="color: #666; text-align: center; padding: 20px;">暂无导入记录</p>';
          return;
        }

        const recentImports = data.history.slice(-10).reverse();
        container.innerHTML = recentImports.map(imp =>
          '<div class="history-item">' +
            '<div>' +
              '<div class="history-name">' + imp.filename + '</div>' +
              '<div class="history-info">' +
                new Date(imp.timestampMs).toLocaleString() + ' | ' +
                imp.summary.packages + ' 个包, ' + imp.summary.versions + ' 个版本' +
              '</div>' +
            '</div>' +
            '<span class="status-badge ' + imp.status + '">' + imp.status + '</span>' +
          '</div>'
        ).join('');
      } catch (error) {
        addLog('加载历史失败: ' + error.message, 'error');
      }
    }

    // 页面加载时加载历史
    document.addEventListener('DOMContentLoaded', function() {
      loadHistory();
    });
  </script>
</body>
</html>`;
}
