package cn.kaoyan.essay.ui;

import android.os.Bundle;
import android.text.TextUtils;
import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Toast;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.fragment.app.Fragment;

import cn.kaoyan.essay.MainActivity;
import cn.kaoyan.essay.R;
import cn.kaoyan.essay.core.AppState;
import cn.kaoyan.essay.databinding.FragmentActivateBinding;
import cn.kaoyan.essay.net.ApiClient;
import cn.kaoyan.essay.net.ApiError;
import cn.kaoyan.essay.net.Dto;
import cn.kaoyan.essay.net.EeaApi;
import cn.kaoyan.essay.runtime.AppLog;

/**
 * 激活页（原生）：调用 /api/license-status 展示当前授权形态，提交 /api/activate 完成激活。
 * 激活成功后进入主界面，不再经过网页激活页。
 */
public class ActivateFragment extends Fragment {

    private FragmentActivateBinding b;
    private ApiClient.Request statusReq;
    private ApiClient.Request activateReq;

    @Nullable
    @Override
    public View onCreateView(@NonNull LayoutInflater inflater, @Nullable ViewGroup container,
                             @Nullable Bundle savedInstanceState) {
        b = FragmentActivateBinding.inflate(inflater, container, false);
        return b.getRoot();
    }

    @Override
    public void onViewCreated(@NonNull View view, @Nullable Bundle savedInstanceState) {
        b.activateButton.setOnClickListener(v -> submit());
        b.activateLogToggle.setOnClickListener(v -> toggleLog());
        b.deviceText.setText(getString(R.string.activate_device, MainActivity.deviceLabel()));
        b.deviceText.setVisibility(View.VISIBLE);
        statusReq = EeaApi.licenseStatus(new ApiClient.Callback<Dto.License>() {
            @Override
            public void onSuccess(Dto.License data) {
                AppState.get().setLicense(data);
                if (b == null) return;
                b.activateHint.setVisibility(View.VISIBLE);
                b.activateHint.setText(data.cloud ? R.string.activate_cloud_on : R.string.activate_cloud_off);
            }

            @Override
            public void onFailure(ApiError error) {
                // 服务未就绪时静默，激活按钮会给出真实报错
            }
        });
    }

    private void submit() {
        String code = b.codeInput.getText() == null ? "" : b.codeInput.getText().toString().trim();
        if (TextUtils.isEmpty(code)) {
            b.codeWrap.setError(getString(R.string.activate_need_code));
            return;
        }
        b.codeWrap.setError(null);
        b.activateButton.setEnabled(false);
        b.activateButton.setText(R.string.activate_checking);
        activateReq = EeaApi.activate(code, new ApiClient.Callback<Dto.Activated>() {
            @Override
            public void onSuccess(Dto.Activated data) {
                if (b == null) return;
                b.activateButton.setEnabled(true);
                b.activateButton.setText(R.string.activate_action);
                Toast.makeText(requireContext(), R.string.activate_ok, Toast.LENGTH_SHORT).show();
                AppState.get().refreshAll();
                host().showShell();
            }

            @Override
            public void onFailure(ApiError error) {
                if (b == null) return;
                b.activateButton.setEnabled(true);
                b.activateButton.setText(R.string.activate_action);
                b.codeWrap.setError(error.getMessage());
            }
        });
    }

    private void toggleLog() {
        boolean showing = b.activateLogCard.getVisibility() == View.VISIBLE;
        if (showing) {
            b.activateLogCard.setVisibility(View.GONE);
            b.activateLogToggle.setText(R.string.view_log);
        } else {
            String text = AppLog.tail(requireContext());
            b.activateLogText.setText(text.isEmpty() ? getString(R.string.log_empty) : text);
            b.activateLogCard.setVisibility(View.VISIBLE);
            b.activateLogToggle.setText(R.string.hide_log);
        }
    }

    @Override
    public void onDestroyView() {
        if (statusReq != null) statusReq.cancel();
        if (activateReq != null) activateReq.cancel();
        statusReq = null;
        activateReq = null;
        b = null;
        super.onDestroyView();
    }

    private MainActivity host() {
        return (MainActivity) requireActivity();
    }
}
