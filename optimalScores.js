/*
RESULTS

- if l and m are equal, it is most optimal for the guide to make a card that half the players will guess

- if l < m, the most optimal is to name a card that LESS than half will guess

- if l > m, the most optimal is to name a card that MORE than half will guess

*/


function calculateOptimalScores(n, chanceThatPlayerGuesses) {
  let l = 2; // score for being voted for
  let m = 1; // score for guessing guide's card
  let k = 3; // score for being guessed by non-zero non-(n-1) amount

//   { // random strategy
//     const chanceThatPlayerGuesses = 1 / (n - 1);
//     const chanceToBeVotedForByAnotherPlayer = (1 - chanceThatPlayerGuesses) / (n - 2)
//     const averageRandomPlayerScore = m * chanceThatPlayerGuesses + l * chanceToBeVotedForByAnotherPlayer * (n - 2);
//     const chanceThatNobodyGuessed = Math.pow(1 - chanceThatPlayerGuesses, n - 1);
//     const chanceThatAllGuessed = Math.pow(chanceThatPlayerGuesses, n - 1);
//     const averageRandomGuideScore = k * (1 - chanceThatNobodyGuessed - chanceThatAllGuessed);
//     // console.log(averageRandomPlayerScore, chanceThatNobodyGuessed, chanceThatAllGuessed, averageRandomGuideScore);
//   }

//   { // obvious strategy
//     const averageObviousPlayerScore = m;
//     const averageObviousGuideScore = 0;
//   }
  
//   { // medium strategy
//     const chanceThatPlayerGuesses = 0.5;
//     const chanceToBeVotedForByAnotherPlayer = (1 - chanceThatPlayerGuesses) / (n - 2)
//     const averageMediumPlayerScore = m * chanceThatPlayerGuesses + l * chanceToBeVotedForByAnotherPlayer * (n - 2);
//     const chanceThatNobodyGuessed = Math.pow(1 - chanceThatPlayerGuesses, n - 1);
//     const chanceThatAllGuessed = Math.pow(chanceThatPlayerGuesses, n - 1);
//     const averageMediumGuideScore = k * (1 - chanceThatNobodyGuessed - chanceThatAllGuessed);
//     console.log(averageMediumPlayerScore, chanceThatNobodyGuessed, chanceThatAllGuessed, averageMediumGuideScore);
//   }
  
  const chanceToBeVotedForByAnotherPlayer = (1 - chanceThatPlayerGuesses) / (n - 2)
  const averagePlayerScore = m * chanceThatPlayerGuesses + l * chanceToBeVotedForByAnotherPlayer * (n - 2);
  const chanceThatNobodyGuessed = Math.pow(1 - chanceThatPlayerGuesses, n - 1);
  const chanceThatAllGuessed = Math.pow(chanceThatPlayerGuesses, n - 1);
  const averageGuideScore = k * (1 - chanceThatNobodyGuessed - chanceThatAllGuessed);
  return {averagePlayerScore, averageGuideScore}
  
}


function ternarySearch(func, returnKey, min = 0, max = 1, comp = (a, b) => a < b) {
  let l = min;
  let r = max;
  
  while (r - l > 0.000000003) {
    const m1 = l + (r - l) / 3;
    const m2 = r - (r - l) / 3;
    const m1Res = func(m1)[returnKey] - func(m1)["averagePlayerScore"];
    const m2Res = func(m2)[returnKey] - func(m2)["averagePlayerScore"];
    if (comp(m1Res, m2Res)) {
      r = m2;
    } else {
      l = m1;
    }
    // console.log(l, r, func(l)[returnKey] - func(l)["averagePlayerScore"], func(r)[returnKey] - func(r)["averagePlayerScore"]);
    
  }
  return l;
}

for (let players = 3; players <= 6; players++) {
    const bestChance = ternarySearch(chance => calculateOptimalScores(players, chance), "averageGuideScore", 1 / players, 1, (a, b) => a > b);
    const bestChanceResult = calculateOptimalScores(players, bestChance);
    console.log(bestChance, bestChanceResult.averageGuideScore - bestChanceResult.averagePlayerScore, bestChanceResult);
}

// const randomChance = 1 / (players - 1);
// console.log(randomChance, calculateOptimalScores(players, randomChance));
