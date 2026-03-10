<template>
  <div class="image-detector-page">
    <el-card class="header-card">
      <h2>图片质量检测</h2>
      <p>上传检修照片，自动识别图片质量是否符合标准</p>
    </el-card>

    <el-card class="upload-card">
      <el-upload
        ref="uploadRef"
        :auto-upload="false"
        :on-change="handleFileChange"
        :file-list="fileList"
        list-type="picture-card"
        accept=".jpg,.jpeg,.png"
        multiple
        :limit="20"
      >
        <el-icon><Plus /></el-icon>
      </el-upload>

      <div class="action-buttons">
        <el-button type="primary" @click="detectImages" :loading="detecting" :disabled="fileList.length === 0">
          开始检测
        </el-button>
        <el-button @click="clearAll" :disabled="fileList.length === 0">清空</el-button>
      </div>
    </el-card>

    <el-card v-if="results.length > 0" class="results-card">
      <h3>检测结果</h3>
      <div class="results-grid">
        <div v-for="(result, index) in results" :key="index" class="result-item">
          <el-image :src="result.preview" fit="cover" class="result-image" />
          <div class="result-info">
            <div class="filename">{{ result.filename }}</div>
            <el-tag :type="result.is_normal ? 'success' : 'danger'" size="large">
              {{ result.predicted_class === 'normal' ? '正常' : '异常' }}
            </el-tag>
            <div class="confidence">置信度: {{ (result.confidence * 100).toFixed(2) }}%</div>
          </div>
        </div>
      </div>
    </el-card>
  </div>
</template>

<script setup>
import { ref } from 'vue';
import { Plus } from '@element-plus/icons-vue';
import { ElMessage } from 'element-plus';
import apiClient from '../utils/apiClient';

const uploadRef = ref(null);
const fileList = ref([]);
const results = ref([]);
const detecting = ref(false);

const handleFileChange = (file, files) => {
  fileList.value = files;
};

const detectImages = async () => {
  if (fileList.value.length === 0) {
    ElMessage.warning('请先选择图片');
    return;
  }

  detecting.value = true;
  const formData = new FormData();
  
  fileList.value.forEach(file => {
    formData.append('files', file.raw);
  });

  try {
    const response = await apiClient.post('/image-detection/detect/batch', formData, {
      headers: { 'Content-Type': 'multipart/form-data' }
    });

    results.value = response.data.results.map((result, index) => ({
      ...result,
      preview: fileList.value[index].url
    }));

    ElMessage.success('检测完成');
  } catch (error) {
    ElMessage.error(error.response?.data?.error || '检测失败');
  } finally {
    detecting.value = false;
  }
};

const clearAll = () => {
  fileList.value = [];
  results.value = [];
  uploadRef.value.clearFiles();
};
</script>

<style scoped>
.image-detector-page {
  padding: 20px;
}

.header-card {
  margin-bottom: 20px;
  text-align: center;
}

.header-card h2 {
  margin: 0 0 10px 0;
  color: #333;
}

.header-card p {
  margin: 0;
  color: #666;
}

.upload-card {
  margin-bottom: 20px;
}

.action-buttons {
  margin-top: 20px;
  text-align: center;
}

.results-card h3 {
  margin-top: 0;
  margin-bottom: 20px;
}

.results-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
  gap: 20px;
}

.result-item {
  border: 1px solid #ddd;
  border-radius: 8px;
  overflow: hidden;
  transition: box-shadow 0.3s;
}

.result-item:hover {
  box-shadow: 0 4px 12px rgba(0,0,0,0.1);
}

.result-image {
  width: 100%;
  height: 200px;
}

.result-info {
  padding: 15px;
  text-align: center;
}

.filename {
  font-size: 14px;
  color: #666;
  margin-bottom: 10px;
  word-break: break-all;
}

.confidence {
  margin-top: 10px;
  font-size: 13px;
  color: #999;
}
</style>
