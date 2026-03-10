import { createRouter, createWebHistory } from 'vue-router';
import { ElMessage } from 'element-plus';

import AuthWorkspacePage from '../pages/AuthWorkspacePage.vue';
import MaintenanceSubmitPage from '../pages/MaintenanceSubmitPage.vue';
import RecordsCenterPage from '../pages/RecordsCenterPage.vue';
import UserManagementPage from '../pages/UserManagementPage.vue';
import WorkspaceShellPage from '../pages/WorkspaceShellPage.vue';
import ApprovalWorkbenchPage from '../pages/ApprovalWorkbenchPage.vue';
import ImageDetectorPage from '../pages/ImageDetectorPage.vue';
import { useAuthSession } from '../stores/authSession';

function hasRoutePermission(auth, route) {
  const requiredPermissions = route.meta?.requiredPermissions || [];
  return auth.hasAnyPermission(requiredPermissions);
}

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/',
      redirect: '/workspace/submit',
    },
    {
      path: '/auth',
      name: 'auth',
      component: AuthWorkspacePage,
    },
    {
      path: '/workspace',
      component: WorkspaceShellPage,
      meta: {
        requiresAuth: true,
      },
      children: [
        {
          path: '',
          redirect: '/workspace/submit',
        },
        {
          path: 'approvals',
          name: 'approval-workbench',
          component: ApprovalWorkbenchPage,
          meta: {
            requiresAuth: true,
            requiredPermissions: ['record.approve'],
          },
        },
        {
          path: 'submit',
          name: 'maintenance-submit',
          component: MaintenanceSubmitPage,
          meta: {
            requiresAuth: true,
            requiredPermissions: ['record.create', 'record.submit'],
          },
        },
        {
          path: 'records',
          name: 'records-center',
          component: RecordsCenterPage,
          meta: {
            requiresAuth: true,
            requiredPermissions: ['record.view'],
          },
        },
        {
          path: 'image-detector',
          name: 'image-detector',
          component: ImageDetectorPage,
          meta: {
            requiresAuth: true,
            requiredPermissions: ['record.view'],
          },
        },
        {
          path: 'users',
          name: 'user-management',
          component: UserManagementPage,
          meta: {
            requiresAuth: true,
            requiredPermissions: ['user.manage', 'role.manage', 'user.preregister'],
          },
        },
      ],
    },
  ],
});

router.beforeEach((to) => {
  const auth = useAuthSession();
  const requiresAuth = to.matched.some((record) => record.meta?.requiresAuth);

  if (!requiresAuth) {
    return true;
  }

  if (!auth.isLoggedIn.value) {
    if (to.path !== '/auth') {
      ElMessage.warning('请先登录后再访问工作台');
    }
    return '/auth';
  }

  if (!to.matched.every((record) => hasRoutePermission(auth, record))) {
    const fallbackRoute = auth.getDefaultWorkspaceRoute();
    if (fallbackRoute === to.path) {
      return '/auth';
    }

    ElMessage.warning('当前账号没有该页面访问权限');
    return fallbackRoute;
  }

  return true;
});

export default router;