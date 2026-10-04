package cn.kaoyan.essay;

import android.content.pm.PackageInfo;
import android.os.Build;
import android.os.Bundle;

import androidx.activity.OnBackPressedCallback;
import androidx.annotation.NonNull;
import androidx.appcompat.app.AppCompatActivity;
import androidx.fragment.app.Fragment;
import androidx.fragment.app.FragmentManager;

import cn.kaoyan.essay.core.AppState;
import cn.kaoyan.essay.databinding.ActivityMainBinding;
import cn.kaoyan.essay.net.ApiClient;
import cn.kaoyan.essay.net.ApiError;
import cn.kaoyan.essay.net.Dto;
import cn.kaoyan.essay.net.EeaApi;
import cn.kaoyan.essay.runtime.NodeRuntime;
import cn.kaoyan.essay.ui.ActivateFragment;
import cn.kaoyan.essay.ui.BackAware;
import cn.kaoyan.essay.ui.ComposeResultFragment;
import cn.kaoyan.essay.ui.ExamDetailFragment;
import cn.kaoyan.essay.ui.ExamsFragment;
import cn.kaoyan.essay.ui.ReviewFragment;
import cn.kaoyan.essay.ui.ReviewResultFragment;
import cn.kaoyan.essay.ui.SettingsFragment;
import cn.kaoyan.essay.ui.SheetFragment;
import cn.kaoyan.essay.ui.SplashFragment;
import cn.kaoyan.essay.ui.StudyFragment;
import cn.kaoyan.essay.ui.WebIslandFragment;
import cn.kaoyan.essay.ui.WriteFragment;

/**
 * 单 Activity 容器：NodeRuntime + 工具栏 + 底部 5 页签 + Fragment 回退栈。
 *
 * 启动链路：splash（Node 启动与健康检查）→ 激活页（未激活时）→ 主界面。
 * 页面本身不再加载 index.html；只有「使用说明」等既有网页通过 WebView 岛屿内嵌。
 */
public class MainActivity extends AppCompatActivity implements NodeRuntime.Listener {

    private static final String TAG_ROOT = "root";
    private static final String TAG_SUB = "sub";

    private static final String STATE_TAB = "eea.tab";
    private static final String STATE_TITLE = "eea.title";
    private static final String STATE_ROOT = "eea.root";

    private static final int ROOT_SPLASH = 0;
    private static final int ROOT_ACTIVATE = 1;
    private static final int ROOT_SHELL = 2;

    private ActivityMainBinding b;
    private NodeRuntime runtime;
    private ApiClient.Request routeReq;

    private int rootKind = ROOT_SPLASH;
    private int currentTabId = R.id.nav_write;
    private String pageTitle = "";
    /** 服务就绪后是否自动决定去向（只有本次会话主动展示启动页时才需要）。 */
    private boolean autoRoute;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        b = ActivityMainBinding.inflate(getLayoutInflater());
        setContentView(b.getRoot());

        setSupportActionBar(b.toolbar);
        if (getSupportActionBar() != null) getSupportActionBar().setDisplayHomeAsUpEnabled(false);

        b.bottomNav.setOnItemSelectedListener(item -> {
            switchTab(item.getItemId());
            return true;
        });
        b.bottomNav.setOnItemReselectedListener(item -> {
            // 再次点击当前页签：回到该页签根页面
            popToRoot();
        });

        getSupportFragmentManager().addOnBackStackChangedListener(this::syncChrome);
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (handleBack()) return;
                setEnabled(false);
                getOnBackPressedDispatcher().onBackPressed();
            }
        });

        runtime = new NodeRuntime(this, this);

        if (savedInstanceState == null) {
            autoRoute = true;
            showSplash();
        } else {
            rootKind = savedInstanceState.getInt(STATE_ROOT, ROOT_SHELL);
            currentTabId = savedInstanceState.getInt(STATE_TAB, R.id.nav_write);
            pageTitle = savedInstanceState.getString(STATE_TITLE, "");
            // 若旋转时正停留在启动页，仍需在服务就绪后继续决定去向
            Fragment current = currentFragment();
            autoRoute = current == null || current instanceof SplashFragment;
            syncChrome();
        }
        // 无论界面恢复到哪里，Node 都必须在这个进程里跑起来
        runtime.start();
    }

    // ---------- NodeRuntime.Listener ----------

    @Override
    public void onStatus(String status) {
        Fragment current = currentFragment();
        if (current instanceof SplashFragment) ((SplashFragment) current).setStatus(status);
    }

    @Override
    public void onReady() {
        AppState.get().refreshAll();
        if (!autoRoute) return;
        autoRoute = false;
        routeReq = EeaApi.licenseStatus(new ApiClient.Callback<Dto.License>() {
            @Override
            public void onSuccess(Dto.License data) {
                AppState.get().setLicense(data);
                if (data.activated) showShell();
                else showActivate();
            }

            @Override
            public void onFailure(ApiError error) {
                // 健康检查已通过却读不到授权：按未激活处理，让用户看到激活页与报错
                showActivate();
            }
        });
    }

    @Override
    public void onFailure(String message) {
        Fragment current = currentFragment();
        if (current instanceof SplashFragment) ((SplashFragment) current).showError(message);
    }

    // ---------- 导航 ----------

    /** 展示启动页（根页面）。 */
    public void showSplash() {
        rootKind = ROOT_SPLASH;
        pageTitle = getString(R.string.app_name);
        replaceRoot(new SplashFragment(), TAG_ROOT);
    }

    /** 展示激活页（根页面）。 */
    public void showActivate() {
        rootKind = ROOT_ACTIVATE;
        pageTitle = getString(R.string.activate_title);
        replaceRoot(new ActivateFragment(), TAG_ROOT);
    }

    /** 进入主界面（底部页签可见）。 */
    public void showShell() {
        rootKind = ROOT_SHELL;
        getSupportFragmentManager().popBackStackImmediate(null, FragmentManager.POP_BACK_STACK_INCLUSIVE);
        switchTab(currentTabId);
    }

    /** 打开设置（子页，压回退栈）。 */
    public void openSettings() {
        push(new SettingsFragment(), getString(R.string.settings_title));
    }

    /** 生成完成后收拢到写作页的子页（生成结果）。 */
    public void openComposeResult() {
        push(new ComposeResultFragment(), getString(R.string.result_title));
    }

    /** 批改完成后的结果子页。 */
    public void openReviewResult() {
        push(new ReviewResultFragment(), getString(R.string.rr_result_title));
    }

    /** 题库详情子页。 */
    public void openExamDetail(String examId, String title) {
        push(ExamDetailFragment.newInstance(examId), title == null || title.isEmpty() ? getString(R.string.tab_exams) : title);
    }

    /** 打开内嵌网页岛屿（子页，压回退栈）。 */
    public void openWebIsland(String title, String url) {
        push(WebIslandFragment.newInstance(title, url), title);
    }

    /** 跨页签跳转（如生成结果页「送答题卡」）：清掉子页并切到目标页签。 */
    public void openTab(int tabId) {
        if (rootKind != ROOT_SHELL) return;
        popToRoot();
        switchTab(tabId);
    }

    /** 当前界面是否需要先退出子页（工具栏返回箭头/物理返回键共用）。 */
    public boolean handleBack() {
        Fragment current = currentFragment();
        if (current instanceof BackAware && ((BackAware) current).onBackPressed()) return true;
        if (getSupportFragmentManager().getBackStackEntryCount() > 0) {
            getSupportFragmentManager().popBackStack();
            return true;
        }
        return false;
    }

    public NodeRuntime runtime() {
        return runtime;
    }

    public String appVersion() {
        try {
            PackageInfo info = getPackageManager().getPackageInfo(getPackageName(), 0);
            return info.versionName == null ? "2.0.0" : info.versionName;
        } catch (Exception e) {
            return "2.0.0";
        }
    }

    /** 设备名：与 Node 侧 EEA_DEVICE_NAME 的口径保持一致。 */
    public static String deviceLabel() {
        String model = Build.MODEL == null || Build.MODEL.trim().isEmpty() ? "Android" : Build.MODEL.trim();
        return model + " · Android " + Build.VERSION.RELEASE;
    }

    private void switchTab(int tabId) {
        currentTabId = tabId;
        if (rootKind != ROOT_SHELL) rootKind = ROOT_SHELL;
        Fragment fragment = shellFragment(tabId);
        pageTitle = getString(titleOfTab(tabId));
        getSupportFragmentManager()
                .beginTransaction()
                .setReorderingAllowed(true)
                .replace(R.id.fragment_container, fragment, TAG_ROOT)
                .commitNow();
        b.bottomNav.getMenu().findItem(tabId).setChecked(true);
        syncChrome();
    }

    private void popToRoot() {
        if (getSupportFragmentManager().getBackStackEntryCount() > 0) {
            getSupportFragmentManager().popBackStackImmediate(null, FragmentManager.POP_BACK_STACK_INCLUSIVE);
        }
    }

    private void replaceRoot(Fragment fragment, String tag) {
        popToRoot();
        getSupportFragmentManager()
                .beginTransaction()
                .setReorderingAllowed(true)
                .replace(R.id.fragment_container, fragment, tag)
                .commitNow();
        syncChrome();
    }

    private void push(Fragment fragment, String title) {
        pageTitle = title;
        getSupportFragmentManager()
                .beginTransaction()
                .setReorderingAllowed(true)
                .replace(R.id.fragment_container, fragment, TAG_SUB)
                .addToBackStack(TAG_SUB)
                .commit();
        syncChrome();
    }

    private Fragment shellFragment(int tabId) {
        if (tabId == R.id.nav_review) {
            return new ReviewFragment();
        }
        if (tabId == R.id.nav_exams) {
            return new ExamsFragment();
        }
        if (tabId == R.id.nav_study) {
            return new StudyFragment();
        }
        if (tabId == R.id.nav_sheet) {
            return new SheetFragment();
        }
        return new WriteFragment();
    }

    private int titleOfTab(int tabId) {
        if (tabId == R.id.nav_review) return R.string.tab_review;
        if (tabId == R.id.nav_exams) return R.string.tab_exams;
        if (tabId == R.id.nav_study) return R.string.tab_study;
        if (tabId == R.id.nav_sheet) return R.string.tab_sheet;
        return R.string.tab_write;
    }

    private Fragment currentFragment() {
        return getSupportFragmentManager().findFragmentById(R.id.fragment_container);
    }

    /** 工具栏标题/返回箭头、底部页签可见性、齿轮可见性统一切换。 */
    private void syncChrome() {
        boolean sub = getSupportFragmentManager().getBackStackEntryCount() > 0;
        if (getSupportActionBar() != null) {
            getSupportActionBar().setDisplayHomeAsUpEnabled(sub);
            getSupportActionBar().setTitle(pageTitle);
        } else {
            b.toolbar.setTitle(pageTitle);
        }
        b.bottomNav.setVisibility(rootKind == ROOT_SHELL && !sub ? android.view.View.VISIBLE : android.view.View.GONE);
        invalidateOptionsMenu();
        syncTabSelection();
    }

    private void syncTabSelection() {
        if (b.bottomNav.getVisibility() != android.view.View.VISIBLE) return;
        for (int i = 0; i < b.bottomNav.getMenu().size(); i++) {
            android.view.MenuItem item = b.bottomNav.getMenu().getItem(i);
            item.setChecked(item.getItemId() == currentTabId);
        }
    }

    // ---------- 工具栏菜单 ----------

    @Override
    public boolean onCreateOptionsMenu(android.view.Menu menu) {
        getMenuInflater().inflate(R.menu.menu_main, menu);
        return true;
    }

    @Override
    public boolean onPrepareOptionsMenu(android.view.Menu menu) {
        android.view.MenuItem settings = menu.findItem(R.id.action_settings);
        boolean sub = getSupportFragmentManager().getBackStackEntryCount() > 0;
        // 齿轮只出现在主界面根页：激活页没配置可改，子页有自己的返回箭头
        if (settings != null) settings.setVisible(rootKind == ROOT_SHELL && !sub);
        return super.onPrepareOptionsMenu(menu);
    }

    @Override
    public boolean onOptionsItemSelected(@NonNull android.view.MenuItem item) {
        if (item.getItemId() == android.R.id.home) {
            handleBack();
            return true;
        }
        if (item.getItemId() == R.id.action_settings) {
            openSettings();
            return true;
        }
        return super.onOptionsItemSelected(item);
    }

    // ---------- 生命周期 ----------

    @Override
    protected void onSaveInstanceState(@NonNull Bundle outState) {
        super.onSaveInstanceState(outState);
        outState.putInt(STATE_TAB, currentTabId);
        outState.putInt(STATE_ROOT, rootKind);
        outState.putString(STATE_TITLE, pageTitle);
    }

    @Override
    protected void onResume() {
        super.onResume();
        AppState.get().refreshAll();
    }

    @Override
    protected void onDestroy() {
        if (routeReq != null) routeReq.cancel();
        routeReq = null;
        if (isFinishing()) {
            // Node 运行在进程内，界面销毁即整体退出（数据均在私有目录，下次启动恢复）
            android.os.Process.killProcess(android.os.Process.myPid());
        }
        super.onDestroy();
    }
}
