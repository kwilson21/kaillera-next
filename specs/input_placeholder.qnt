// A JS neutral placeholder has not necessarily been fed to the native ring.
// The first real neutral input must be fed; later true duplicates must not.
module input_placeholder {
  const FIXED: bool
  var placeholder: bool
  var feeds: int
  action init = all { placeholder' = true, feeds' = 0 }
  action receive = all {
    placeholder' = false,
    feeds' = if (placeholder and FIXED) feeds + 1 else feeds
  }
  action step = receive
  val allHold = (not(placeholder) implies feeds == 1) and feeds <= 1
  run neutralHeaderTest = init.then(receive).expect(allHold == FIXED)
  run neutralRedundancyTest = init.then(receive).expect(allHold == FIXED)
  run trueDuplicateTest = init.then(receive).then(receive).expect(allHold == FIXED)
}
module input_placeholder_before { import input_placeholder(FIXED = false).* }
module input_placeholder_fixed { import input_placeholder(FIXED = true).* }
