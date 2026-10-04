package cn.kaoyan.essay.ui;

import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.fragment.app.Fragment;

import com.google.android.material.button.MaterialButton;
import com.google.android.material.card.MaterialCardView;
import android.widget.ScrollView;
import android.widget.TextView;

import cn.kaoyan.essay.MainActivity;
import cn.kaoyan.essay.R;
import cn.kaoyan.essay.databinding.FragmentSplashBinding;
import cn.kaoyan.essay.runtime.AppLog;
import cn.kaoyan.essay.runtime.NodeRuntime;

/**
 * 启动页：展示本地服务启动进度，失败可重试，并可随时展开 Node 日志。
 * 真正的解压/启动逻辑在 {@link NodeRuntime}，这里只订阅状态。
 */
public class SplashFragment extends Fragment {

    private FragmentSplashBinding b;
    private NodeRuntime runtime;
    private final Handler ticker = new Handler(Looper.getMainLooper());
    private final Runnable logRefresh = new Runnable() {
        @Override
        public void run() {
            if (b == null || b.logCard.getVisibility() != View.VISIBLE) return;
            b.logText.setText(logText());
            // 内层 lambda 延迟执行，期间 b 可能已被 onDestroyView 置空，必须再判一次
            b.logScroll.post(() -> {
                if (b != null) b.logScroll.fullScroll(View.FOCUS_DOWN);
            });
            ticker.postDelayed(this, 1500);
        }
    };

    @Nullable
    @Override
    public View onCreateView(@NonNull LayoutInflater inflater, @Nullable ViewGroup container,
                             @Nullable Bundle savedInstanceState) {
        b = FragmentSplashBinding.inflate(inflater, container, false);
        return b.getRoot();
    }

    @Override
    public void onViewCreated(@NonNull View view, @Nullable Bundle savedInstanceState) {
        MainActivity host = host();
        runtime = host.runtime();
        b.retryButton.setOnClickListener(v -> {
            hideError();
            runtime.retry();
        });
        b.logToggle.setOnClickListener(v -> toggleLog());
        if (runtime.isReady()) b.statusText.setText(R.string.splash_waiting);
    }

    public void setStatus(String text) {
        if (b == null || text == null) return;
        b.progress.setVisibility(View.VISIBLE);
        b.statusText.setText(text);
    }

    public void showError(String message) {
        if (b == null) return;
        b.progress.setVisibility(View.GONE);
        b.statusText.setText(message);
        b.retryButton.setVisibility(View.VISIBLE);
        // 失败时自动展开日志：真机上用户一眼能看到原因
        if (b.logCard.getVisibility() != View.VISIBLE) toggleLog();
    }

    private void hideError() {
        b.retryButton.setVisibility(View.GONE);
        b.statusText.setText(R.string.starting);
        b.progress.setVisibility(View.VISIBLE);
    }

    private void toggleLog() {
        boolean showing = b.logCard.getVisibility() == View.VISIBLE;
        if (showing) {
            b.logCard.setVisibility(View.GONE);
            b.logToggle.setText(R.string.view_log);
            ticker.removeCallbacks(logRefresh);
        } else {
            b.logCard.setVisibility(View.VISIBLE);
            b.logToggle.setText(R.string.hide_log);
            b.logText.setText(logText());
            b.logScroll.post(() -> b.logScroll.fullScroll(View.FOCUS_DOWN));
            ticker.postDelayed(logRefresh, 1500);
        }
    }

    private String logText() {
        String text = AppLog.tail(requireContext());
        return text.isEmpty() ? getString(R.string.log_empty) : text;
    }

    @Override
    public void onDestroyView() {
        ticker.removeCallbacks(logRefresh);
        b = null;
        super.onDestroyView();
    }

    private MainActivity host() {
        return (MainActivity) requireActivity();
    }
}
