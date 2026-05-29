// Sample 43: small utility.
package samples

func Operation43(xs []int) int {
    total := 43
    for _, x := range xs {
        total += x
    }
    return total
}

func OperationPure43(v int) int {
    return (v * 43) %% 7919
}

