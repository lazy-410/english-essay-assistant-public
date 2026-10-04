package cn.kaoyan.essay.ui;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.JavascriptInterface;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.ArrayAdapter;
import android.widget.SeekBar;
import android.widget.Toast;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.fragment.app.Fragment;

import com.google.android.material.button.MaterialButton;
import com.google.android.material.button.MaterialButtonToggleGroup;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import cn.kaoyan.essay.R;
import cn.kaoyan.essay.core.SheetState;
import cn.kaoyan.essay.databinding.FragmentSheetBinding;
import cn.kaoyan.essay.net.ApiClient;
import cn.kaoyan.essay.net.ApiError;
import cn.kaoyan.essay.net.Dto;
import cn.kaoyan.essay.net.EeaApi;
import cn.kaoyan.essay.util.Exports;

/**
 * 答题卡页：预览走 WebView 岛屿（public/preview.html），PNG 光栅化走 headless 岛屿（public/raster.html），
 * PDF 走原生二进制下载。控制项与 /api/handwrite 请求体同构，取自 SheetState。
 */
public class SheetFragment extends Fragment {

    private static final String PAGE_PREVIEW = "/preview.html";
    private static final String PAGE_RASTER = "/raster.html";
    private static final long RENDER_DEBOUNCE_MS = 320L;
    private static final int PNG_SCALE = 2;

    private FragmentSheetBinding b;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable renderTask = this::renderNow;
    private final Map<Integer, String> templateValues = new LinkedHashMap<>();
    private final List<Dto.HandTemplate> templates = new ArrayList<>();
    private final List<Dto.HandFont> fonts = new ArrayList<>();
    private final List<ApiClient.Request> requests = new ArrayList<>();

    private boolean previewReady;
    private boolean rasterReady;
    private boolean suppress;
    private JSONObject pendingRaster;

    @Nullable
    @Override
    public View onCreateView(@NonNull LayoutInflater inflater, @Nullable ViewGroup container,
                             @Nullable Bundle savedInstanceState) {
        b = FragmentSheetBinding.inflate(inflater, container, false);
        setupPreview();
        setupRaster();
        bindControls();
        restoreControls();
        loadLists();
        b.sheetPreview.loadUrl(ApiClient.BASE_URL + PAGE_PREVIEW);
        b.sheetRaster.loadUrl(ApiClient.BASE_URL + PAGE_RASTER);
        return b.getRoot();
    }

    // ---------- WebView 岛屿 ----------

    @SuppressLint("SetJavaScriptEnabled")
    private void setupPreview() {
        WebSettings s = b.sheetPreview.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setTextZoom(100);
        b.sheetPreview.setBackgroundColor(0);
        b.sheetPreview.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView view, String url) {
                previewReady = true;
                updateEmptyState();
                renderNow();
            }
        });
        b.sheetPreview.addJavascriptInterface(new PreviewBridge(), "EeaPreviewBridge");
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void setupRaster() {
        WebSettings s = b.sheetRaster.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setTextZoom(100);
        b.sheetRaster.setBackgroundColor(0);
        b.sheetRaster.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView view, String url) {
                rasterReady = true;
                if (pendingRaster != null) {
                    JSONObject payload = pendingRaster;
                    pendingRaster = null;
                    runRaster(payload);
                }
            }
        });
        b.sheetRaster.addJavascriptInterface(new RasterBridge(), "EEABridge");
    }

    /** 预览页回报的行数状态。 */
    private final class PreviewBridge {
        @JavascriptInterface
        public void onSheetStatus(String json) {
            Activity activity = getActivity();
            if (activity == null) return;
            activity.runOnUiThread(() -> applyStatus(json));
        }
    }

    /** PNG 导出桥：与 WebIslandFragment 同名接口，额外支持错误回报。 */
    private final class RasterBridge {
        @JavascriptInterface
        public void shareBase64(String fileName, String base64Data, String mime) {
            Activity activity = getActivity();
            if (activity == null) return;
            Exports.shareBase64(activity, fileName, base64Data, mime);
            // 传资源 id 而非先 getString：参数会在 toast 的 isAdded() 之前求值，
            // 而 Fragment.getString 在分离后抛 IllegalStateException（导出完立刻切页签就会崩）
            activity.runOnUiThread(() -> {
                setBusy(false);
                toastRes(R.string.sheet_png_ready);
            });
            }

            @JavascriptInterface
            public void onRasterError(String message) {
            Activity activity = getActivity();
            if (activity == null) return;
            activity.runOnUiThread(() -> {
                setBusy(false);
                toastRes(R.string.sheet_export_failed, message);
            });
        }
    }

    private void applyStatus(String json) {
        if (b == null) return;
        setBusy(false);
        try {
            JSONObject o = new JSONObject(json == null ? "{}" : json);
            if (!o.optBoolean("ok", false)) {
                b.sheetStatus.setText(o.optString("error", getString(R.string.sheet_status_idle)));
                return;
            }
            int used = o.optInt("usedLines", 0);
            int available = o.optInt("availableLines", 0);
            int overflow = o.optInt("overflowLines", 0);
            b.sheetStatus.setText(getString(R.string.sheet_status_lines, used, available));
            if (overflow > 0) {
                b.sheetEmpty.setVisibility(View.GONE);
                b.sheetStatus.setText(getString(R.string.sheet_status_overflow, overflow));
            }
        } catch (Exception e) {
            b.sheetStatus.setText(getString(R.string.sheet_export_failed, e.getMessage()));
        }
    }

    // ---------- 控制项 ----------

    private void bindControls() {
        b.sheetTemplateGroup.addOnButtonCheckedListener((group, checkedId, isChecked) -> {
            if (!isChecked || suppress) return;
            String value = templateValues.get(checkedId);
            if (value != null) {
                SheetState.template = value;
                scheduleRender();
            }
        });
        b.sheetFont.setOnItemClickListener((parent, view, position, id) -> {
            if (suppress || position < 0 || position >= fonts.size()) return;
            SheetState.fontId = fonts.get(position).id;
            scheduleRender();
        });
        b.sheetColorGroup.addOnButtonCheckedListener((group, checkedId, isChecked) -> {
            if (!isChecked || suppress) return;
            if (checkedId == R.id.sheet_color_black) SheetState.color = "black";
            else if (checkedId == R.id.sheet_color_red) SheetState.color = "red";
            else if (checkedId == R.id.sheet_color_blue) SheetState.color = "blue";
            else SheetState.color = "darkgray";
            scheduleRender();
        });
        b.sheetStyleGroup.addOnButtonCheckedListener((group, checkedId, isChecked) -> {
            if (!isChecked || suppress) return;
            SheetState.style = checkedId == R.id.sheet_style_indent ? "indent" : "block";
            scheduleRender();
        });
        b.sheetKindGroup.addOnButtonCheckedListener((group, checkedId, isChecked) -> {
            if (!isChecked || suppress) return;
            SheetState.kind = checkedId == R.id.sheet_kind_notice ? "notice" : "letter";
            applyKindVisibility();
            scheduleRender();
        });
        b.sheetSize.setOnSeekBarChangeListener(new SimpleSeek() {
            @Override
            public void onProgressChanged(SeekBar seekBar, int progress, boolean fromUser) {
                int value = SheetState.FONT_SIZE_MIN + progress;
                b.sheetSizeLabel.setText(getString(R.string.sheet_label_size, value));
                if (fromUser && !suppress) {
                    SheetState.fontSize = value;
                    scheduleRender();
                }
            }
        });
        b.sheetSlant.setOnSeekBarChangeListener(new SimpleSeek() {
            @Override
            public void onProgressChanged(SeekBar seekBar, int progress, boolean fromUser) {
                b.sheetSlantLabel.setText(getString(R.string.sheet_label_slant, progress));
                if (fromUser && !suppress) {
                    SheetState.slant = progress;
                    scheduleRender();
                }
            }
        });
        b.sheetBaseline.setOnSeekBarChangeListener(new SimpleSeek() {
            @Override
            public void onProgressChanged(SeekBar seekBar, int progress, boolean fromUser) {
                int value = progress - SheetState.BASELINE_LIMIT;
                b.sheetBaselineLabel.setText(getString(R.string.sheet_label_baseline, value));
                if (fromUser && !suppress) {
                    SheetState.baselineAdjust = value;
                    scheduleRender();
                }
            }
        });
        b.sheetText.addTextChangedListener(new SimpleText() {
            @Override
            public void afterTextChanged(android.text.Editable s) {
                if (suppress) return;
                SheetState.essayText = s == null ? "" : s.toString();
                updateEmptyState();
                scheduleRender();
            }
        });
        b.sheetSalutation.addTextChangedListener(new SimpleText() {
            @Override
            public void afterTextChanged(android.text.Editable s) {
                if (suppress) return;
                SheetState.salutation = s == null ? "" : s.toString();
                scheduleRender();
            }
        });
        b.sheetSignature.addTextChangedListener(new SimpleText() {
            @Override
            public void afterTextChanged(android.text.Editable s) {
                if (suppress) return;
                SheetState.signature = s == null ? "" : s.toString();
                scheduleRender();
            }
        });
        b.sheetTitle.addTextChangedListener(new SimpleText() {
            @Override
            public void afterTextChanged(android.text.Editable s) {
                if (suppress) return;
                SheetState.title = s == null ? "" : s.toString();
                scheduleRender();
            }
        });
        b.sheetDate.addTextChangedListener(new SimpleText() {
            @Override
            public void afterTextChanged(android.text.Editable s) {
                if (suppress) return;
                SheetState.date = s == null ? "" : s.toString();
                scheduleRender();
            }
        });
        b.sheetPresetExam.setOnClickListener(v -> {
            SheetState.presetExam();
            restoreControls();
            scheduleRender();
        });
        b.sheetPresetCopybook.setOnClickListener(v -> {
            SheetState.presetCopybook();
            restoreControls();
            scheduleRender();
        });
        b.sheetRender.setOnClickListener(v -> renderNow());
        b.sheetPdf.setOnClickListener(v -> exportPdf());
        b.sheetPng.setOnClickListener(v -> exportPng());
    }

    /** 把 SheetState 回填到控件（不回触发渲染）。 */
    private void restoreControls() {
        suppress = true;
        b.sheetText.setText(SheetState.essayText);
        b.sheetSalutation.setText(SheetState.salutation);
        b.sheetSignature.setText(SheetState.signature);
        b.sheetTitle.setText(SheetState.title);
        b.sheetDate.setText(SheetState.date);
        b.sheetSize.setProgress(clamp(SheetState.fontSize - SheetState.FONT_SIZE_MIN, 0, b.sheetSize.getMax()));
        b.sheetSizeLabel.setText(getString(R.string.sheet_label_size, SheetState.fontSize));
        b.sheetSlant.setProgress(clamp(SheetState.slant, 0, b.sheetSlant.getMax()));
        b.sheetSlantLabel.setText(getString(R.string.sheet_label_slant, SheetState.slant));
        b.sheetBaseline.setProgress(clamp(SheetState.baselineAdjust + SheetState.BASELINE_LIMIT,
                0, b.sheetBaseline.getMax()));
        b.sheetBaselineLabel.setText(getString(R.string.sheet_label_baseline, SheetState.baselineAdjust));
        check(b.sheetColorGroup, colorButton(SheetState.color));
        check(b.sheetStyleGroup, "indent".equals(SheetState.style) ? R.id.sheet_style_indent : R.id.sheet_style_block);
        check(b.sheetKindGroup, "notice".equals(SheetState.kind) ? R.id.sheet_kind_notice : R.id.sheet_kind_letter);
        suppress = false;
        applyKindVisibility();
        updateEmptyState();
    }

    private void check(MaterialButtonToggleGroup group, int buttonId) {
        if (buttonId == View.NO_ID) return;
        if (group.getCheckedButtonId() == buttonId) return;
        group.check(buttonId);
    }

    private int colorButton(String color) {
        if ("red".equals(color)) return R.id.sheet_color_red;
        if ("blue".equals(color)) return R.id.sheet_color_blue;
        if ("darkgray".equals(color)) return R.id.sheet_color_darkgray;
        return R.id.sheet_color_black;
    }

    private void applyKindVisibility() {
        boolean notice = "notice".equals(SheetState.kind);
        b.sheetSalutationWrap.setVisibility(notice ? View.GONE : View.VISIBLE);
        b.sheetSignatureWrap.setVisibility(notice ? View.GONE : View.VISIBLE);
        b.sheetTitleWrap.setVisibility(notice ? View.VISIBLE : View.GONE);
        b.sheetDateWrap.setVisibility(notice ? View.VISIBLE : View.GONE);
    }

    private void updateEmptyState() {
        if (b == null) return;
        boolean empty = !SheetState.hasEssay();
        b.sheetEmpty.setVisibility(empty ? View.VISIBLE : View.GONE);
        if (empty) {
            b.sheetStatus.setText(R.string.sheet_status_idle);
            if (previewReady) evaluate(b.sheetPreview, "window.EeaSheet && window.EeaSheet.clear()");
        }
    }

    // ---------- 列表（模板 / 字体） ----------

    private void loadLists() {
        requests.add(EeaApi.handTemplates(new ApiClient.Callback<Dto.HandTemplates>() {
            @Override
            public void onSuccess(Dto.HandTemplates data) {
                applyTemplates(data == null ? null : data.items);
            }

            @Override
            public void onFailure(ApiError error) {
                if (isAdded()) toast(getString(R.string.sheet_render_failed, error.getMessage()));
            }
        }));
        requests.add(EeaApi.handFonts(new ApiClient.Callback<Dto.HandFonts>() {
            @Override
            public void onSuccess(Dto.HandFonts data) {
                applyFonts(data == null ? null : data.items);
            }

            @Override
            public void onFailure(ApiError error) {
                // 字体列表失败时仍可用服务端默认字体
            }
        }));
    }

    private void applyTemplates(List<Dto.HandTemplate> items) {
        if (b == null || items == null || items.isEmpty()) return;
        suppress = true;
        templates.clear();
        templates.addAll(items);
        b.sheetTemplateGroup.removeAllViews();
        templateValues.clear();
        int spacing = (int) (12 * getResources().getDisplayMetrics().density);
        int wanted = View.NO_ID;
        for (Dto.HandTemplate item : items) {
            MaterialButton button = new MaterialButton(requireContext(), null,
                    com.google.android.material.R.attr.materialButtonOutlinedStyle);
            button.setId(View.generateViewId());
            button.setText(item.label.isEmpty() ? item.key : item.label);
            button.setTextSize(12f);
            button.setMinHeight(0);
            button.setMinimumHeight(0);
            button.setPadding(spacing, 0, spacing, 0);
            b.sheetTemplateGroup.addView(button);
            templateValues.put(button.getId(), item.key);
            if (item.key.equals(SheetState.template)) wanted = button.getId();
        }
        if (wanted == View.NO_ID) {
            // 状态里没有可用模板：默认选第一个，保持与服务端可用列表一致
            SheetState.template = items.get(0).key;
            wanted = templateValues.keySet().iterator().next();
        }
        b.sheetTemplateGroup.check(wanted);
        suppress = false;
    }

    private void applyFonts(List<Dto.HandFont> items) {
        if (b == null || items == null || items.isEmpty()) return;
        suppress = true;
        fonts.clear();
        fonts.addAll(items);
        List<String> labels = new ArrayList<>();
        int wanted = 0;
        for (int i = 0; i < items.size(); i++) {
            Dto.HandFont font = items.get(i);
            labels.add(font.recommended ? getString(R.string.sheet_font_recommended, font.label) : font.label);
            if (SheetState.fontId.equals(font.id)) wanted = i;
        }
        if (SheetState.fontId.isEmpty()) {
            for (int i = 0; i < items.size(); i++) {
                if (items.get(i).recommended) {
                    wanted = i;
                    break;
                }
            }
            SheetState.fontId = items.get(wanted).id;
        }
        ArrayAdapter<String> adapter = new ArrayAdapter<>(requireContext(),
                android.R.layout.simple_list_item_1, labels);
        b.sheetFont.setAdapter(adapter);
        b.sheetFont.setText(labels.get(wanted), false);
        suppress = false;
    }

    // ---------- 渲染 ----------

    private void scheduleRender() {
        handler.removeCallbacks(renderTask);
        if (!SheetState.hasEssay()) return;
        handler.postDelayed(renderTask, RENDER_DEBOUNCE_MS);
    }

    private void renderNow() {
        if (b == null || !previewReady) return;
        if (!SheetState.hasEssay()) {
            updateEmptyState();
            return;
        }
        setBusy(true);
        b.sheetStatus.setText(R.string.sheet_status_rendering);
        evaluate(b.sheetPreview, "window.EeaSheet && window.EeaSheet.render("
                + JSONObject.quote(SheetState.payload().toString()) + ")");
    }

    private void exportPdf() {
        if (!requireEssay()) return;
        setBusy(true);
        requests.add(EeaApi.handwritePdf(SheetState.payload(), new ApiClient.Callback<byte[]>() {
            @Override
            public void onSuccess(byte[] data) {
                if (getActivity() == null) return;
                setBusy(false);
                if (data == null || data.length == 0) {
                    toast(getString(R.string.sheet_export_failed, "返回内容为空"));
                    return;
                }
                Exports.shareBytes(requireActivity(), exportName("pdf"), data, "application/pdf");
            }

            @Override
            public void onFailure(ApiError error) {
                setBusy(false);
                if (isAdded()) toast(getString(R.string.sheet_export_failed, error.getMessage()));
            }
        }));
    }

    private void exportPng() {
        if (!requireEssay()) return;
        JSONObject payload = SheetState.payload();
        setBusy(true);
        b.sheetStatus.setText(R.string.sheet_status_rendering);
        if (rasterReady) runRaster(payload);
        else pendingRaster = payload;
    }

    private void runRaster(JSONObject payload) {
        if (b == null) return;
        evaluate(b.sheetRaster, "window.EeaRaster && window.EeaRaster.run("
                + JSONObject.quote(payload.toString()) + "," + PNG_SCALE + ","
                + JSONObject.quote(exportName("png")) + ")");
    }

    private String exportName(String ext) {
        String base = "答题卡";
        for (Dto.HandTemplate item : templates) {
            if (item.key.equals(SheetState.template)) {
                StringBuilder sb = new StringBuilder("答题卡");
                if (!item.exam.isEmpty()) sb.append('-').append(item.exam);
                if (!item.part.isEmpty()) sb.append("-Part").append(item.part);
                base = sb.toString();
                break;
            }
        }
        java.util.Calendar now = java.util.Calendar.getInstance();
        String stamp = String.format(java.util.Locale.US, "%04d%02d%02d",
                now.get(java.util.Calendar.YEAR), now.get(java.util.Calendar.MONTH) + 1,
                now.get(java.util.Calendar.DAY_OF_MONTH));
        return base + "-" + stamp + "." + ext;
    }

    private boolean requireEssay() {
        if (SheetState.hasEssay()) return true;
        toast(getString(R.string.sheet_need_essay));
        return false;
    }

    private void evaluate(WebView view, String js) {
        try {
            view.evaluateJavascript(js, null);
        } catch (Exception e) {
            setBusy(false);
        }
    }

    private void setBusy(boolean busy) {
        if (b == null) return;
        b.sheetProgress.setVisibility(busy ? View.VISIBLE : View.GONE);
    }

    private void toast(String message) {
        if (!isAdded()) return;
        Toast.makeText(requireContext(), message, Toast.LENGTH_LONG).show();
    }

    /** 与 toast 同义，但把 getString 推到 isAdded() 之后求值：异步回调里必须用这个。 */
    private void toastRes(int resId, Object... args) {
        if (!isAdded()) return;
        Toast.makeText(requireContext(), getString(resId, args), Toast.LENGTH_LONG).show();
    }

    private static int clamp(int value, int min, int max) {
        return Math.max(min, Math.min(max, value));
    }

    @Override
    public void onDestroyView() {
        handler.removeCallbacks(renderTask);
        for (ApiClient.Request request : requests) request.cancel();
        requests.clear();
        if (b != null) {
            b.sheetPreview.removeJavascriptInterface("EeaPreviewBridge");
            b.sheetRaster.removeJavascriptInterface("EEABridge");
            b.sheetPreview.destroy();
            b.sheetRaster.destroy();
        }
        b = null;
        super.onDestroyView();
    }

    // ---------- 小工具 ----------

    /** SeekBar 只关心进度变化。 */
    private abstract static class SimpleSeek implements SeekBar.OnSeekBarChangeListener {
        @Override
        public void onStartTrackingTouch(SeekBar seekBar) {
        }

        @Override
        public void onStopTrackingTouch(SeekBar seekBar) {
        }
    }

    /** 文本变化只关心 afterTextChanged。 */
    private abstract static class SimpleText implements android.text.TextWatcher {
        @Override
        public void beforeTextChanged(CharSequence s, int start, int count, int after) {
        }

        @Override
        public void onTextChanged(CharSequence s, int start, int before, int count) {
        }
    }
}
