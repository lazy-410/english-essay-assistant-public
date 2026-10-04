package cn.kaoyan.essay.ui;

import android.os.Bundle;
import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.fragment.app.Fragment;
import androidx.fragment.app.FragmentTransaction;

import com.google.android.material.tabs.TabLayout;

import cn.kaoyan.essay.R;
import cn.kaoyan.essay.databinding.FragmentStudyBinding;

/**
 * 学习页外壳：四个子页签（背诵卡片 / 模板字典 / 行文解析 / 模块组装）。
 * 子页用事务替换到容器里，切换时保留各自状态由 Fragment 自身负责（数据都在服务端）。
 */
public class StudyFragment extends Fragment {

    private static final String TAG_PREFIX = "study-sub-";

    private FragmentStudyBinding b;
    private int currentIndex = -1;

    public StudyFragment() {
        super(R.layout.fragment_study);
    }

    @Nullable
    @Override
    public View onCreateView(@NonNull LayoutInflater inflater, @Nullable ViewGroup container, @Nullable Bundle savedInstanceState) {
        b = FragmentStudyBinding.inflate(inflater, container, false);
        return b.getRoot();
    }

    @Override
    public void onViewCreated(@NonNull View view, @Nullable Bundle savedInstanceState) {
        super.onViewCreated(view, savedInstanceState);
        String[] titles = {
                getString(R.string.study_tab_cards),
                getString(R.string.study_tab_dict),
                getString(R.string.study_tab_analysis),
                getString(R.string.study_tab_modules),
        };
        for (String title : titles) {
            b.studyTabs.addTab(b.studyTabs.newTab().setText(title));
        }
        b.studyTabs.addOnTabSelectedListener(new TabLayout.OnTabSelectedListener() {
            @Override
            public void onTabSelected(TabLayout.Tab tab) {
                show(tab.getPosition());
            }

            @Override
            public void onTabUnselected(TabLayout.Tab tab) {
            }

            @Override
            public void onTabReselected(TabLayout.Tab tab) {
            }
        });
        show(savedInstanceState == null ? 0 : savedInstanceState.getInt("index", 0));
    }

    @Override
    public void onSaveInstanceState(@NonNull Bundle outState) {
        super.onSaveInstanceState(outState);
        outState.putInt("index", currentIndex < 0 ? 0 : currentIndex);
    }

    @Override
    public void onDestroyView() {
        super.onDestroyView();
        b = null;
    }

    private void show(int index) {
        if (b == null || index == currentIndex) return;
        Fragment fragment = create(index);
        if (fragment == null) return;
        currentIndex = index;
        FragmentTransaction tx = getChildFragmentManager().beginTransaction();
        tx.setReorderingAllowed(true);
        tx.replace(R.id.study_container, fragment, TAG_PREFIX + index);
        tx.commit();
        if (b.studyTabs.getSelectedTabPosition() != index) {
            TabLayout.Tab tab = b.studyTabs.getTabAt(index);
            if (tab != null) tab.select();
        }
    }

    private Fragment create(int index) {
        switch (index) {
            case 0:
                return new StudyCardsFragment();
            case 1:
                return new StudyDictFragment();
            case 2:
                return new StudyAnalysisFragment();
            case 3:
                return new StudyAssemblyFragment();
            default:
                return null;
        }
    }
}
