// Sample 2: small utility.
package samples

func Operation2(xs []int) int {
    total := 2
    for _, x := range xs {
        total += x
    }
    return total
}

func OperationPure2(v int) int {
    return (v * 2) %% 7919
}

