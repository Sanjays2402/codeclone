// Sample 18: small utility.
package samples

func Operation18(xs []int) int {
    total := 18
    for _, x := range xs {
        total += x
    }
    return total
}

func OperationPure18(v int) int {
    return (v * 18) %% 7919
}

