package cn.kaoyan.essay.core;

import android.os.Handler;
import android.os.Looper;

import java.util.concurrent.CopyOnWriteArrayList;

import cn.kaoyan.essay.net.ApiClient;
import cn.kaoyan.essay.net.Dto;
import cn.kaoyan.essay.net.EeaApi;

/**
 * 轻量内存仓库：缓存健康/授权/配置/备考方向，供各页面共享。
 * 不做持久化（真相永远在本地服务的 config.json 与授权文件里），进程重启后重新拉取。
 */
public final class AppState {

    public interface Listener {
        void onAppStateChanged();
    }

    private static final AppState INSTANCE = new AppState();

    public static AppState get() {
        return INSTANCE;
    }

    private final CopyOnWriteArrayList<Listener> listeners = new CopyOnWriteArrayList<>();
    private final Handler main = new Handler(Looper.getMainLooper());

    private volatile Dto.Health health;
    private volatile Dto.License license;
    private volatile Dto.Config config;
    private volatile Dto.ExamType examType;

    private AppState() {
    }

    // ---------- 读取 ----------

    public Dto.Health health() {
        return health;
    }

    public Dto.License license() {
        return license;
    }

    public Dto.Config config() {
        return config;
    }

    public Dto.ExamType examType() {
        return examType;
    }

    public boolean isActivated() {
        Dto.License l = license;
        if (l != null) return l.activated;
        Dto.Health h = health;
        return h != null && h.activated;
    }

    public boolean hasApiKey() {
        Dto.Config c = config;
        if (c != null) return c.deepseekKeySet;
        Dto.Health h = health;
        return h != null && h.hasApiKey;
    }

    // ---------- 写入 ----------

    public void setHealth(Dto.Health value) {
        health = value;
        notifyChanged();
    }

    public void setLicense(Dto.License value) {
        license = value;
        notifyChanged();
    }

    public void setConfig(Dto.Config value) {
        config = value;
        if (value != null && value.examType != null) {
            Dto.ExamType e = examType;
            if (e == null) e = new Dto.ExamType();
            e.examType = value.examType;
            e.chosen = true;
            examType = e;
        }
        notifyChanged();
    }

    public void setExamType(Dto.ExamType value) {
        examType = value;
        notifyChanged();
    }

    // ---------- 刷新 ----------

    /** 服务就绪后拉一遍基础状态（健康 + 授权 + 配置 + 备考方向）。 */
    public void refreshAll() {
        EeaApi.health(new SimpleCallback<>(this::setHealth));
        EeaApi.licenseStatus(new SimpleCallback<>(this::setLicense));
        EeaApi.config(new SimpleCallback<>(this::setConfig));
        EeaApi.examType(new SimpleCallback<>(this::setExamType));
    }

    // ---------- 监听 ----------

    public void addListener(Listener l) {
        listeners.addIfAbsent(l);
    }

    public void removeListener(Listener l) {
        listeners.remove(l);
    }

    private void notifyChanged() {
        main.post(() -> {
            for (Listener l : listeners) l.onAppStateChanged();
        });
    }

    /** 忽略失败的回调包装：这些是状态刷新，失败时保持旧值即可。 */
    private static final class SimpleCallback<T> implements ApiClient.Callback<T> {
        private final java.util.function.Consumer<T> consumer;

        SimpleCallback(java.util.function.Consumer<T> consumer) {
            this.consumer = consumer;
        }

        @Override
        public void onSuccess(T data) {
            consumer.accept(data);
        }

        @Override
        public void onFailure(cn.kaoyan.essay.net.ApiError error) {
            // 状态刷新失败不弹错，页面各自决定是否重试
        }
    }
}
