package cn.kaoyan.essay.ui;

import android.os.Bundle;
import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import android.widget.ArrayAdapter;
import android.widget.Toast;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.fragment.app.Fragment;

import com.google.android.material.dialog.MaterialAlertDialogBuilder;
import com.google.android.material.textfield.MaterialAutoCompleteTextView;

import org.json.JSONObject;

import cn.kaoyan.essay.MainActivity;
import cn.kaoyan.essay.R;
import cn.kaoyan.essay.core.AppState;
import cn.kaoyan.essay.databinding.FragmentSettingsBinding;
import cn.kaoyan.essay.net.ApiClient;
import cn.kaoyan.essay.net.ApiError;
import cn.kaoyan.essay.net.Dto;
import cn.kaoyan.essay.net.EeaApi;
import cn.kaoyan.essay.runtime.AppLog;

/**
 * 设置页：备考方向 / DeepSeek / 千问视觉 / 使用说明 / 关于。
 * 所有改动经 /api/config 与 /api/study/exam-type 落盘到本地服务，界面只反映服务端事实。
 */
public class SettingsFragment extends Fragment implements AppState.Listener {

    private static final String[] DEEPSEEK_MODELS = {"deepseek-v4-flash", "deepseek-chat", "deepseek-reasoner"};
    private static final String[] VISION_MODELS = {"qwen3.7-plus", "qwen-vl-max", "qwen-vl-plus"};

    private FragmentSettingsBinding b;
    private ApiClient.Request saveReq;
    private ApiClient.Request testReq;
    private ApiClient.Request statsReq;
    private boolean suppressToggle;

    @Nullable
    @Override
    public View onCreateView(@NonNull LayoutInflater inflater, @Nullable ViewGroup container,
                             @Nullable Bundle savedInstanceState) {
        b = FragmentSettingsBinding.inflate(inflater, container, false);
        return b.getRoot();
    }

    @Override
    public void onViewCreated(@NonNull View view, @Nullable Bundle savedInstanceState) {
        setupDropdown(b.deepseekModelReasoning, DEEPSEEK_MODELS);
        setupDropdown(b.deepseekModelFast, DEEPSEEK_MODELS);
        setupDropdown(b.visionModel, VISION_MODELS);

        b.examTypeGroup.addOnButtonCheckedListener((group, checkedId, isChecked) -> {
            if (suppressToggle || !isChecked) return;
            String examType = checkedId == R.id.exam_type_e2 ? "e2" : "e1";
            EeaApi.setExamType(examType, new ApiClient.Callback<Dto.ExamType>() {
                @Override
                public void onSuccess(Dto.ExamType data) {
                    AppState.get().setExamType(data);
                    toast(getString(R.string.study_saved, data.label == null ? examType : data.label));
                }

                @Override
                public void onFailure(ApiError error) {
                    toast(getString(R.string.save_failed, error.getMessage()));
                }
            });
        });

        b.deepseekSave.setOnClickListener(v -> saveDeepseek());
        b.visionSave.setOnClickListener(v -> saveVision());
        b.deepseekTest.setOnClickListener(v -> testDeepseek());
        b.visionTest.setOnClickListener(v -> testVision());
        b.helpRow.setOnClickListener(v -> host().openWebIsland(getString(R.string.web_title_help),
                ApiClient.BASE_URL + "/manual.html"));
        b.aboutReactivate.setOnClickListener(v -> host().showActivate());
        b.aboutLog.setOnClickListener(v -> showLog());
    }

    @Override
    public void onStart() {
        super.onStart();
        AppState.get().addListener(this);
        render();
        AppState.get().refreshAll();
        loadStats();
    }

    @Override
    public void onStop() {
        AppState.get().removeListener(this);
        super.onStop();
    }

    @Override
    public void onAppStateChanged() {
        render();
    }

    // ---------- 渲染 ----------

    private void render() {
        if (b == null) return;
        AppState state = AppState.get();
        Dto.Config c = state.config();
        Dto.ExamType e = state.examType();
        Dto.License l = state.license();
        Dto.Health h = state.health();

        suppressToggle = true;
        if (e != null && "e1".equals(e.examType)) {
            b.examTypeGroup.check(R.id.exam_type_e1);
        } else if (e != null && "e2".equals(e.examType)) {
            b.examTypeGroup.check(R.id.exam_type_e2);
        } else {
            b.examTypeGroup.clearChecked();
        }
        suppressToggle = false;

        if (c != null) {
            b.deepseekStatus.setText(c.deepseekKeySet
                    ? getString(R.string.settings_key_keep, c.deepseekKeyMasked)
                    : getString(R.string.settings_key_none));
            if (!c.modelReasoning.isEmpty()) setDropdownText(b.deepseekModelReasoning, c.modelReasoning);
            if (!c.modelFast.isEmpty()) setDropdownText(b.deepseekModelFast, c.modelFast);
            b.visionStatus.setText(c.visionKeySet
                    ? getString(R.string.settings_key_keep, c.visionKeyMasked)
                    : getString(R.string.vision_key_none));
            if (!c.visionModel.isEmpty()) setDropdownText(b.visionModel, c.visionModel);
        }

        b.aboutVersion.setText(getString(R.string.settings_version, host().appVersion()));
        if (l != null && l.activated) {
            String when = l.activatedAt == null ? "" : l.activatedAt;
            b.aboutLicense.setText(getString(R.string.settings_license_activated, when.isEmpty() ? getString(R.string.license_permanent) : when));
            b.aboutCloud.setText(l.cloud ? R.string.settings_cloud_on : R.string.settings_cloud_off);
        } else {
            b.aboutLicense.setText(R.string.settings_license_not_activated);
            b.aboutCloud.setText(l != null && l.cloud ? R.string.settings_cloud_on : R.string.settings_cloud_off);
        }
        if (h != null) {
            b.aboutRuntime.setText(getString(R.string.settings_runtime, h.node + " · " + h.platform));
        }
    }

    private void loadStats() {
        statsReq = EeaApi.writingStats(new ApiClient.Callback<Dto.WritingStats>() {
            @Override
            public void onSuccess(Dto.WritingStats w) {
                EeaApi.kbStats(new ApiClient.Callback<Dto.KbStats>() {
                    @Override
                    public void onSuccess(Dto.KbStats k) {
                        if (b == null) return;
                        b.aboutKb.setText(getString(R.string.settings_kb_stats, w.skeletons, w.variants, k.examEssays));
                    }

                    @Override
                    public void onFailure(ApiError error) {
                        // 统计失败不阻塞设置页
                    }
                });
            }

            @Override
            public void onFailure(ApiError error) {
                // 统计失败不阻塞设置页
            }
        });
    }

    // ---------- 保存 / 测试 ----------

    private void saveDeepseek() {
        String key = text(b.deepseekKeyInput);
        JSONObject ds = new JSONObject();
        put(ds, "apiKey", key);
        put(ds, "modelReasoning", text(b.deepseekModelReasoning));
        put(ds, "modelFast", text(b.deepseekModelFast));
        if (ds.length() == 0) {
            toast(getString(R.string.save_nothing));
            return;
        }
        JSONObject patch = new JSONObject();
        putJson(patch, "deepseek", ds);
        saveReq = EeaApi.saveConfig(patch, configCallback());
    }

    private void saveVision() {
        String key = text(b.visionKeyInput);
        JSONObject v = new JSONObject();
        put(v, "apiKey", key);
        put(v, "model", text(b.visionModel));
        if (v.length() == 0) {
            toast(getString(R.string.save_nothing));
            return;
        }
        JSONObject patch = new JSONObject();
        putJson(patch, "vision", v);
        saveReq = EeaApi.saveConfig(patch, configCallback());
    }

    private ApiClient.Callback<Dto.Config> configCallback() {
        return new ApiClient.Callback<Dto.Config>() {
            @Override
            public void onSuccess(Dto.Config data) {
                AppState.get().setConfig(data);
                if (b != null) {
                    b.deepseekKeyInput.setText("");
                    b.visionKeyInput.setText("");
                }
                toast(getString(R.string.settings_saved));
            }

            @Override
            public void onFailure(ApiError error) {
                toast(getString(R.string.save_failed, error.getMessage()));
            }
        };
    }

    private void testDeepseek() {
        b.deepseekTest.setEnabled(false);
        b.deepseekTest.setText(R.string.settings_testing);
        b.deepseekTestResult.setVisibility(View.VISIBLE);
        b.deepseekTestResult.setText(R.string.settings_testing);
        testReq = EeaApi.testDeepseek(new ApiClient.Callback<Dto.TestResult>() {
            @Override
            public void onSuccess(Dto.TestResult data) {
                if (b == null) return;
                b.deepseekTest.setEnabled(true);
                b.deepseekTest.setText(R.string.settings_test);
                b.deepseekTestResult.setText(getString(R.string.test_ok, data.describe()));
            }

            @Override
            public void onFailure(ApiError error) {
                if (b == null) return;
                b.deepseekTest.setEnabled(true);
                b.deepseekTest.setText(R.string.settings_test);
                b.deepseekTestResult.setText(getString(R.string.test_failed, error.getMessage()));
            }
        });
    }

    private void testVision() {
        b.visionTest.setEnabled(false);
        b.visionTest.setText(R.string.settings_testing);
        b.visionTestResult.setVisibility(View.VISIBLE);
        b.visionTestResult.setText(R.string.settings_testing);
        testReq = EeaApi.testVision(new ApiClient.Callback<Dto.TestResult>() {
            @Override
            public void onSuccess(Dto.TestResult data) {
                if (b == null) return;
                b.visionTest.setEnabled(true);
                b.visionTest.setText(R.string.settings_test);
                b.visionTestResult.setText(getString(R.string.vision_test_ok, data.describe()));
            }

            @Override
            public void onFailure(ApiError error) {
                if (b == null) return;
                b.visionTest.setEnabled(true);
                b.visionTest.setText(R.string.settings_test);
                b.visionTestResult.setText(getString(R.string.vision_test_failed, error.getMessage()));
            }
        });
    }

    private void showLog() {
        String text = AppLog.tail(requireContext());
        if (text.isEmpty()) text = getString(R.string.log_empty);
        new MaterialAlertDialogBuilder(requireContext())
                .setTitle(R.string.view_log)
                .setMessage(text)
                .setPositiveButton(R.string.close, null)
                .show();
    }

    // ---------- 小工具 ----------

    private void setupDropdown(MaterialAutoCompleteTextView view, String[] options) {
        view.setAdapter(new ArrayAdapter<>(requireContext(), android.R.layout.simple_list_item_1, options));
    }

    private void setDropdownText(MaterialAutoCompleteTextView view, String value) {
        // 第二个参数 false：直接设定文本，不触发过滤
        view.setText(value, false);
    }

    private String text(android.widget.EditText field) {
        return field.getText() == null ? "" : field.getText().toString().trim();
    }

    private void put(JSONObject o, String key, String value) {
        if (value == null || value.isEmpty()) return;
        try {
            o.put(key, value);
        } catch (Exception ignored) {
            // JSONObject.put 不会抛
        }
    }

    private void putJson(JSONObject o, String key, JSONObject value) {
        try {
            o.put(key, value);
        } catch (Exception ignored) {
            // 同上
        }
    }

    private void toast(String message) {
        if (getContext() == null) return;
        Toast.makeText(requireContext(), message, Toast.LENGTH_SHORT).show();
    }

    @Override
    public void onDestroyView() {
        if (saveReq != null) saveReq.cancel();
        if (testReq != null) testReq.cancel();
        if (statsReq != null) statsReq.cancel();
        saveReq = null;
        testReq = null;
        statsReq = null;
        b = null;
        super.onDestroyView();
    }

    private MainActivity host() {
        return (MainActivity) requireActivity();
    }
}
