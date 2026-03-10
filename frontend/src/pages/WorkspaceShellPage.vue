<script setup>
import { computed, ref } from 'vue';
import { RouterLink, RouterView, useRoute, useRouter } from 'vue-router';
import { CircleCheck, DocumentAdd, Document, User, Expand, Fold, Picture } from '@element-plus/icons-vue';
import { useAuthSession } from '../stores/authSession';

const route = useRoute();
const router = useRouter();
const auth = useAuthSession();

const sidebarCollapsed = ref(false);

const navItems = [
  {
    label: '审批工作台',
    caption: '待审核、待放行与驳回处理',
    icon: 'CircleCheck',
    to: '/workspace/approvals',
    routeName: 'approval-workbench',
    requiredPermissions: ['record.approve'],
  },
  {
    label: '提交中心',
    caption: '新建检修记录与附件草案',
    icon: 'DocumentAdd',
    to: '/workspace/submit',
    routeName: 'maintenance-submit',
    requiredPermissions: ['record.create', 'record.submit'],
  },
  {
    label: '记录查阅',
    caption: '查阅 revision、签名和状态流转',
    icon: 'Document',
    to: '/workspace/records',
    routeName: 'records-center',
    requiredPermissions: ['record.view'],
  },
  {
    label: '图片检测',
    caption: '检修照片质量自动识别',
    icon: 'Picture',
    to: '/workspace/image-detector',
    routeName: 'image-detector',
    requiredPermissions: ['record.view'],
  },
  {
    label: '人员管理',
    caption: '账号、角色和指定签名人配置',
    icon: 'User',
    to: '/workspace/users',
    routeName: 'user-management',
    requiredPermissions: ['user.manage', 'role.manage', 'user.preregister'],
  },
];

const visibleNavItems = computed(() => navItems.filter((item) => auth.hasAnyPermission(item.requiredPermissions)));

const routeMeta = computed(() => {
  const matched = navItems.find((item) => item.routeName === route.name);
  return matched || visibleNavItems.value[0] || navItems[0];
});

const activeMenu = computed(() => String(route.path || '/workspace/approvals'));

const currentUser = computed(() => auth.latestLoggedInUser.value);
const toggleLabel = computed(() => (sidebarCollapsed.value ? '展开侧栏' : '收起侧栏'));
const toggleIconComponent = computed(() => (sidebarCollapsed.value ? Expand : Fold));

const iconComponents = {
  CircleCheck,
  DocumentAdd,
  Document,
  Picture,
  User,
};

function toggleSidebar() {
  sidebarCollapsed.value = !sidebarCollapsed.value;
}

function resetWorkspace() {
  auth.resetAuthSession();
  router.push('/auth');
}
</script>

<template>
  <div class="workspace-shell" :class="{ 'is-sidebar-collapsed': sidebarCollapsed }">
    <aside class="workspace-sidebar" :class="{ 'is-collapsed': sidebarCollapsed }">
      <div class="workspace-sidebar-head">
        <div class="workspace-brand">
          <div class="workspace-brand-mark">AE</div>
          <div class="workspace-brand-text" :class="{ 'is-hidden': sidebarCollapsed }">
            <div class="workspace-brand-title">Aero Evidence</div>
            <div class="workspace-brand-subtitle">维修记录业务台</div>
          </div>
        </div>
      </div>

      <div class="workspace-nav-shell">
        <el-menu
          class="workspace-nav-menu"
          :default-active="activeMenu"
          :collapse="sidebarCollapsed"
          router
        >
          <el-menu-item
            v-for="item in visibleNavItems"
            :key="item.to"
            :index="item.to"
            class="workspace-menu-item"
          >
            <el-icon class="workspace-nav-icon" :size="28">
              <component :is="iconComponents[item.icon]" />
            </el-icon>
            <template #title>
              <span class="workspace-nav-copy">
                <span class="workspace-nav-label">{{ item.label }}</span>
                <span class="workspace-nav-caption">{{ item.caption }}</span>
              </span>
            </template>
          </el-menu-item>
        </el-menu>

        <button type="button" class="workspace-toggle-entry" @click="toggleSidebar" :title="toggleLabel">
          <el-icon class="workspace-nav-icon" :size="28">
            <component :is="toggleIconComponent" />
          </el-icon>
        </button>
      </div>

      <div class="workspace-sidebar-footer">
        <div v-if="currentUser" class="workspace-user-card" :class="{ 'is-collapsed': sidebarCollapsed }">
          <template v-if="sidebarCollapsed">
            <div class="workspace-user-monogram">{{ String(currentUser.name || 'U').slice(0, 1) }}</div>
            <div class="workspace-user-meta">{{ currentUser.employeeNo }}</div>
          </template>
          <template v-else>
            <div class="workspace-user-name">{{ currentUser.name }}</div>
            <div class="workspace-user-meta">{{ currentUser.employeeNo }}</div>
          </template>
        </div>
      </div>
    </aside>

    <div class="workspace-main">
      <header class="workspace-topbar">
        <div>
          <div class="workspace-kicker">Maintenance Control Console</div>
          <h1 class="workspace-title">{{ routeMeta.label }}</h1>
          <p class="workspace-subtitle">{{ routeMeta.caption }}</p>
        </div>

        <div class="workspace-top-actions">
          <RouterLink to="/auth" class="workspace-auth-link">认证页</RouterLink>
          <el-button @click="resetWorkspace">退出工作台</el-button>
        </div>
      </header>

      <main class="workspace-content">
        <RouterView />
      </main>
    </div>
  </div>
</template>