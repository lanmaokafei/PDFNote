-- 评分撤销：日志里记住评分前的调度状态，才能无损回滚（同时删除这条日志）。
-- 旧日志这些列是 NULL，撤销时按下标不存在处理（会明确报错而不是乱写）。
ALTER TABLE review_logs ADD COLUMN previous_stability REAL;
ALTER TABLE review_logs ADD COLUMN previous_difficulty REAL;
ALTER TABLE review_logs ADD COLUMN previous_elapsed_days REAL;
ALTER TABLE review_logs ADD COLUMN previous_scheduled_days REAL;
ALTER TABLE review_logs ADD COLUMN previous_learning_steps INTEGER;
ALTER TABLE review_logs ADD COLUMN previous_reps INTEGER;
ALTER TABLE review_logs ADD COLUMN previous_lapses INTEGER;
ALTER TABLE review_logs ADD COLUMN previous_last_review TEXT;
