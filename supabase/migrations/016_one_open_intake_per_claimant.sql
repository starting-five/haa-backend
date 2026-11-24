-- 016_one_open_intake_per_claimant.sql
--
-- A claimant holds at most one submission that is still in intake.
--
-- /intake/start opens a case for a claimant who has none. Two first starts for
-- the same patient can both see a claimant with no submission, because neither
-- has inserted yet, and without this index both inserts succeed and the patient
-- ends up with two open cases. With it, the later insert is refused with a
-- unique violation and the route carries on with the case the earlier one
-- opened.
--
-- claimants.user_id and claimants.mobile already close the same race one step
-- earlier, for the claimant row itself; this closes it for the case.
--
-- Submitted and later cases are not covered: whether one patient may hold
-- several of those is an open product decision, and this index says nothing
-- about it.
--
-- Creating the index fails if any claimant already holds two submissions in
-- intake. That is deliberate: those rows need a person to decide which case is
-- the real one, and silently picking one here would discard a patient's answers.

create unique index if not exists idx_intake_submissions_one_open_per_claimant
  on intake_submissions (claimant_id)
  where status = 'intake';
