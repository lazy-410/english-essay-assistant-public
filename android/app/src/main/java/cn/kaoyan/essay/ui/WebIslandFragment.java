package cn.kaoyan.essay.ui;

import android.annotation.SuppressLint;
import android.os.Bundle;
import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.DownloadListener;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.fragment.app.Fragment;

import cn.kaoyan.essay.MainActivity;
import cn.kaoyan.essay.databinding.FragmentWebIslandBinding;
import cn.kaoyan.essay.net.ApiClient;
import cn.kaoyan.essay.util.Exports;

/**
 * 内嵌网页岛屿：使用说明等既有网页在这个 WebView 里展示，
 * 导出类操作走 EEABridge → 系统分享面板（与桌面端同一套导出约定）。
 */
public class WebIslandFragment extends Fragment implements BackAware {

    private static final String ARG_TITLE = "title";
    private static final String ARG_URL = "url";

    private FragmentWebIslandBinding b;

    public static WebIslandFragment newInstance(String title, String url) {
        WebIslandFragment f = new WebIslandFragment();
        Bundle args = new Bundle();
        args.putString(ARG_TITLE, title);
        args.putString(ARG_URL, url);
        f.setArguments(args);
        return f;
    }

    public static String titleOf(Bundle args) {
        return args == null ? null : args.getString(ARG_TITLE);
    }

    @Nullable
    @Override
    public View onCreateView(@NonNull LayoutInflater inflater, @Nullable ViewGroup container,
                             @Nullable Bundle savedInstanceState) {
        b = FragmentWebIslandBinding.inflate(inflater, container, false);
        setupWebView();
        String url = getArguments() == null ? null : getArguments().getString(ARG_URL);
        if (url != null) b.webView.loadUrl(url);
        return b.getRoot();
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void setupWebView() {
        WebSettings s = b.webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        // 关键：关掉多窗口后，target="_blank" / window.open 的链接会就地加载，而不是被丢掉。
        s.setSupportMultipleWindows(false);
        s.setJavaScriptCanOpenWindowsAutomatically(true);

        b.webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return handleUrl(request.getUrl().toString());
            }

            // minSdk 24 下框架只会派发上面的 WebResourceRequest 版本；保留这个旧签名
            // 仅作 OEM WebView 仍派发旧回调时的兜底，缺了它站外链接会直接在 App 内打开
            @Override
            @SuppressWarnings("deprecation")
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return handleUrl(url);
            }
        });
        b.webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView view, int newProgress) {
                if (b == null) return;
                b.webProgress.setProgress(newProgress);
                b.webProgress.setVisibility(newProgress >= 100 ? View.GONE : View.VISIBLE);
            }
        });
        b.webView.setDownloadListener(new DownloadListener() {
            @Override
            public void onDownloadStart(String url, String userAgent, String contentDisposition,
                                        String mimetype, long contentLength) {
                if (url != null && (url.startsWith("http://") || url.startsWith("https://"))) {
                    Exports.saveDownload(requireContext(), url, mimetype);
                }
            }
        });
        b.webView.addJavascriptInterface(new Bridge(), "EEABridge");
    }

    @Override
    public boolean onBackPressed() {
        if (b != null && b.webView.canGoBack()) {
            b.webView.goBack();
            return true;
        }
        return false;
    }

    /**
     * 链接处理：http(s) 交回 WebView 就地打开（含 target="_blank"），
     * 「返回软件」这类回本站首页的入口直接退回原生界面，其他协议不接管。
     */
    private boolean handleUrl(String url) {
        if (url == null) return true;
        String home = ApiClient.BASE_URL + "/";
        if (url.equals(home) || url.equals(ApiClient.BASE_URL)) {
            MainActivity activity = (MainActivity) getActivity();
            if (activity != null) activity.handleBack();
            return true;
        }
        return !(url.startsWith("http://") || url.startsWith("https://"));
    }

    @Override
    public void onDestroyView() {
        if (b != null) {
            b.webView.setWebChromeClient(null);
            b.webView.destroy();
        }
        b = null;
        super.onDestroyView();
    }

    /** 网页导出桥：与桌面端 EeaBridge 同名同参数。 */
    private final class Bridge {
        @JavascriptInterface
        public void shareBase64(String fileName, String base64Data, String mime) {
            if (getActivity() == null) return;
            Exports.shareBase64(requireActivity(), fileName, base64Data, mime);
        }
    }
}
